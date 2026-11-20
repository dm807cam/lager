import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, type HubEvent } from '../src/data/hub.js';
import { ingestCost, InstanceData, newDocId } from '../src/data/store.js';
import { LagerError } from '../src/errors.js';

const MiB = 1024 * 1024;
let store: InstanceData | undefined;
afterEach(() => { store?.close(); store = undefined; });

function make(quotaBytes = 50 * MiB): { store: InstanceData; hub: Hub; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-ingest-'));
  const hub = new Hub();
  store = new InstanceData(dir, hub, 20, quotaBytes);
  return { store, hub, dir };
}

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof LagerError ? e.code : String(e); }
  return undefined;
};

/** The bytes the database file really holds, free pages left out: what `usage` reported before documents from outside existed. */
function fileBytes(dir: string, instanceId: string): number {
  const db = new DatabaseSync(path.join(dir, 'instances', instanceId, 'data.sqlite'), { readOnly: true });
  const n = (pragma: string): number => Number((db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma]);
  const bytes = (n('page_count') - n('freelist_count')) * n('page_size');
  db.close();
  return bytes;
}

describe('documents from outside in the store', () => {
  it('are ordinary documents: readable, queryable, exported, announced', () => {
    const { store, hub } = make();
    const events: HubEvent[] = [];
    hub.subscribe('i1', (e) => events.push(e));
    const doc = store.ingest('i1', 'hits/a1', { path: '/' }, { by: null, quotaBytes: MiB, rotate: false });
    expect(doc).toMatchObject({ path: 'hits/a1', id: 'a1', data: { path: '/' }, version: 1, updatedBy: null });
    expect(store.get('i1', 'hits/a1')?.data).toEqual({ path: '/' });
    expect(store.query('i1', 'hits', { where: [['path', '==', '/']] })).toHaveLength(1);
    expect([...store.exportDocs('i1')]).toEqual([{ path: 'hits/a1', data: { path: '/' } }]);
    expect(events).toEqual([{ type: 'change', path: 'hits/a1', parent: 'hits' }]);
  });

  it('only ever add: an id that exists is not overwritten', () => {
    const { store } = make();
    store.set('i1', 'hits/a1', { mine: true }, 'u1');
    expect(() => store.ingest('i1', 'hits/a1', { theirs: true }, { by: null, quotaBytes: MiB, rotate: false })).toThrow();
    expect(store.get('i1', 'hits/a1')?.data).toEqual({ mine: true });
    expect(store.ingestUsage('i1')).toBe(0);
  });

  it('are held to the rules for paths and documents', () => {
    const { store } = make();
    const opts = { by: null, quotaBytes: MiB, rotate: false };
    expect(code(() => store.ingest('i1', 'hits', { a: 1 }, opts))).toBe('invalid_argument');
    expect(code(() => store.ingest('i1', 'hits/../x', { a: 1 }, opts))).toBe('invalid_argument');
    expect(code(() => store.ingest('i1', 'hits/a', [1] as never, opts))).toBe('invalid_argument');
    expect(code(() => store.ingest('i1', 'hits/a', { n: Infinity }, opts))).toBe('invalid_argument');
    expect(store.hasData('i1')).toBe(false);
  });

  it('count against the ingest quota and not against the storage of the instance', () => {
    const { store, dir } = make();
    store.set('i1', 'notes/n1', { text: 'x'.repeat(5000) }, 'u1');
    const own = store.usage('i1');
    for (let i = 0; i < 300; i++) store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(700), n: i }, { by: null, quotaBytes: MiB, rotate: false });
    const received = store.ingestUsage('i1');
    expect(received).toBeGreaterThan(300 * 700);
    expect(store.usage('i1')).toBeLessThanOrEqual(own);
    // What is counted for the documents from outside covers the pages they really take.
    expect(fileBytes(dir, 'i1') - own).toBeLessThanOrEqual(received);
  });

  it('a full ingest quota refuses further documents and nothing else', () => {
    const { store } = make();
    const opts = { by: null, quotaBytes: 30_000, rotate: false };
    let stored = 0;
    while (code(() => store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(900) }, opts)) === undefined) stored++;
    expect(stored).toBeGreaterThan(10);
    expect(store.ingestUsage('i1')).toBeLessThanOrEqual(30_000);
    expect(code(() => store.ingest('i1', `hits/${newDocId()}`, { a: 1 }, { ...opts, quotaBytes: 30_000 }))).toBeUndefined();
    expect(code(() => store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(900) }, opts))).toBe('quota_exceeded');
    // One document that is larger than the whole quota is refused even with rotation.
    expect(code(() => store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(40_000) }, { ...opts, rotate: true }))).toBe('quota_exceeded');
    expect(store.query('i1', 'hits')).toHaveLength(stored + 1);
    // The instance's own writes go on.
    expect(code(() => store.set('i1', 'notes/n1', { text: 'x'.repeat(100_000) }, 'u1'))).toBeUndefined();
  });

  it('a full instance refuses the owner\'s writes, yet still takes documents from outside into their own quota', () => {
    const { store } = make(200_000);
    while (code(() => store.set('i1', `notes/${newDocId()}`, { text: 'x'.repeat(20_000) }, 'u1')) === undefined) { /* fill */ }
    expect(code(() => store.set('i1', 'notes/more', { a: 1 }, 'u1'))).toBe('quota_exceeded');
    expect(code(() => store.ingest('i1', `hits/${newDocId()}`, { a: 1 }, { by: null, quotaBytes: MiB, rotate: false }))).toBeUndefined();
    // And taking them in does not make the instance any fuller for its owner once there is room again.
    for (const d of store.query('i1', 'notes', { limit: 3 })) store.delete('i1', d.path);
    expect(code(() => store.set('i1', 'notes/more', { a: 1 }, 'u1'))).toBeUndefined();
  });

  it('rotation drops the oldest received documents of the same collection only', () => {
    const { store, hub } = make();
    const opts = { by: null, quotaBytes: 30_000, rotate: true };
    store.ingest('i1', 'messages/m1', { text: 'keep me' }, { ...opts, rotate: false });
    store.set('i1', 'hits/own', { mine: true }, 'u1');
    const events: HubEvent[] = [];
    hub.subscribe('i1', (e) => events.push(e));
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) { ids.push(`h${String(i).padStart(3, '0')}`); store.ingest('i1', `hits/${ids[i]}`, { text: 'x'.repeat(900) }, opts); }
    const left = store.query('i1', 'hits').map((d) => d.id).filter((id) => id !== 'own');
    expect(left.length).toBeLessThan(40);
    expect(left).toEqual(ids.slice(100 - left.length));
    expect(store.get('i1', 'messages/m1')).not.toBeNull();
    expect(store.get('i1', 'hits/own')).not.toBeNull();
    expect(store.ingestUsage('i1')).toBeLessThanOrEqual(30_000);
    // Whoever listens to a dropped document hears that it went.
    expect(events).toContainEqual({ type: 'change', path: 'hits/h000', parent: 'hits' });
    // With nothing of its own to drop, a rotating collection is refused like any other.
    expect(code(() => store.ingest('i1', `other/${newDocId()}`, { text: 'x'.repeat(900) }, opts))).toBe('quota_exceeded');
  });

  it('a document someone with write access changes becomes the instance\'s own; a deleted one makes room', () => {
    const { store } = make();
    const opts = { by: null, quotaBytes: 30_000, rotate: true };
    store.ingest('i1', 'hits/a', { text: 'x'.repeat(900) }, opts);
    store.ingest('i1', 'hits/b', { text: 'x'.repeat(900) }, opts);
    store.ingest('i1', 'hits/c', { text: 'x'.repeat(900) }, opts);
    const each = store.ingestUsage('i1') / 3;
    store.update('i1', 'hits/a', { approved: true }, 'u1');
    expect(store.ingestUsage('i1')).toBe(2 * each);
    store.delete('i1', 'hits/b');
    expect(store.ingestUsage('i1')).toBe(each);
    store.acquire('i1', 'hits/c', { holder: 'me' }, 'u1');
    expect(store.ingestUsage('i1')).toBe(0);
    // Rotation never touches what was changed since it came in.
    for (let i = 0; i < 100; i++) store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(900) }, opts);
    expect(store.get('i1', 'hits/a')?.data).toMatchObject({ approved: true });
    expect(store.get('i1', 'hits/c')).not.toBeNull();
  });

  it('an import over a received document makes it the instance\'s own as well', () => {
    const { store } = make();
    store.ingest('i1', 'hits/a', { n: 1 }, { by: null, quotaBytes: MiB, rotate: false });
    store.importDocs('i1', [{ path: 'hits/a', data: { n: 2 } }], 'u1');
    expect(store.ingestUsage('i1')).toBe(0);
  });

  it('snapshots and restores keep the bookkeeping with the documents', () => {
    const { store } = make();
    const opts = { by: null, quotaBytes: MiB, rotate: false };
    store.ingest('i1', 'hits/a', { n: 1 }, opts);
    const before = store.ingestUsage('i1');
    const snap = store.snapshot('i1', 'before')!;
    store.ingest('i1', 'hits/b', { n: 2 }, opts);
    store.delete('i1', 'hits/a');
    store.restore('i1', snap.id);
    expect(store.query('i1', 'hits').map((d) => d.id)).toEqual(['a']);
    expect(store.ingestUsage('i1')).toBe(before);
  });

  it('a database from before this feature gets its tables when it is opened', () => {
    const { store, dir } = make();
    fs.mkdirSync(path.join(dir, 'instances', 'old'), { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'instances', 'old', 'data.sqlite'));
    db.exec(`CREATE TABLE docs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL,
      created_at TEXT, updated_at TEXT, updated_by TEXT, lease_holder TEXT, lease_expires TEXT);
      INSERT INTO docs (path, parent, id, data, version) VALUES ('notes/n1', 'notes', 'n1', '{"a":1}', 1);`);
    db.close();
    expect(store.ingestUsage('old')).toBe(0);
    expect(store.usage('old')).toBeGreaterThan(0);
    store.ingest('old', 'hits/a', { n: 1 }, { by: null, quotaBytes: MiB, rotate: false });
    expect(store.get('old', 'notes/n1')?.data).toEqual({ a: 1 });
    expect(store.ingestUsage('old')).toBeGreaterThan(0);
  });

  it('a signed-in visitor who appends is remembered as an author', () => {
    const { store } = make();
    store.ingest('i1', 'rsvps/a', { name: 'Ada' }, { by: 'u7', quotaBytes: MiB, rotate: false });
    expect(store.get('i1', 'rsvps/a')?.updatedBy).toBe('u7');
    expect(store.hasAuthor('i1', 'u7')).toBe(true);
  });
});

describe('ids the server makes up', () => {
  it('are 20 letters and digits, and every character is equally likely', () => {
    const counts = new Map<string, number>();
    const ids = new Set<string>();
    for (let i = 0; i < 6200; i++) {
      const id = newDocId();
      expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
      ids.add(id);
      for (const c of id) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(ids.size).toBe(6200);
    expect(counts.size).toBe(62);
    // 124000 characters: 2000 of each, give or take. A random byte taken modulo 62 would give the first eight about 2420.
    for (const [c, n] of counts) expect(Math.abs(n - 2000), c).toBeLessThan(300);
  });
});

describe('what a document from outside counts', () => {
  // Whoever sends chooses the size. For every size, and for a collection that rotates for a long time, the pages the
  // documents take must stay within what is counted for them: otherwise data from outside would eat into the instance's own space.
  it.each([
    ['tiny hits', 40, 'hits'], ['small events', 300, 'hits'], ['just under half a page', 1800, 'hits'],
    ['just over half a page', 1900, 'inbox/main/messages'], ['just over a third of a page', 1300, 'hits'],
    ['a page', 3900, 'hits'], ['spilling over', 4200, 'hits'], ['two pages', 9000, 'hooks'], ['the largest request', 64 * 1024, 'hooks'],
  ])('covers the pages it takes: %s', (_label, size, collection) => {
    const { store, dir } = make();
    store.set('i1', 'notes/n1', { a: 1 }, 'u1');
    const base = fileBytes(dir, 'i1');
    const quota = 2 * MiB;
    const text = 'x'.repeat(size);
    let worst = 0;
    const rounds = Math.max(120, Math.ceil((3 * quota) / (size + 200)));
    for (let i = 0; i < rounds; i++) {
      store.ingest('i1', `${collection}/${newDocId()}`, { text }, { by: null, quotaBytes: quota, rotate: true });
      if (i % 50 === 0 || i === rounds - 1) worst = Math.max(worst, fileBytes(dir, 'i1') - base - store.ingestUsage('i1'));
    }
    expect(store.ingestUsage('i1')).toBeLessThanOrEqual(quota);
    expect(worst).toBeLessThanOrEqual(0);
  }, 60_000);

  it('grows with the document and with its path', () => {
    expect(ingestCost('hits/abc', '{"a":1}')).toBeLessThan(ingestCost('hits/abc', JSON.stringify({ a: 'x'.repeat(500) })));
    expect(ingestCost('hits/abc', '{"a":1}')).toBeLessThan(ingestCost('a/long/collection/path/abc', '{"a":1}'));
    // A small document costs a few hundred bytes, not a page.
    expect(ingestCost(`hits/${newDocId()}`, '{"path":"/","_receivedAt":"2026-03-01T10:00:00.000Z"}')).toBeLessThan(700);
  });
});
