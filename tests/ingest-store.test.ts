import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, type HubEvent } from '../src/data/hub.js';
import { InstanceData, newDocId } from '../src/data/store.js';
import { LagerError } from '../src/errors.js';

const KiB = 1024;
const MiB = 1024 * KiB;
let store: InstanceData | undefined;
afterEach(() => { store?.close(); store = undefined; });

/** A store whose instances may hold `ingestQuota` bytes of documents from outside, next to `quota` bytes of their own. */
function make(ingestQuota = MiB, quota = 50 * MiB): { store: InstanceData; hub: Hub; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-ingest-'));
  const hub = new Hub();
  store = new InstanceData(dir, hub, 20, quota, undefined, ingestQuota);
  return { store, hub, dir };
}

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof LagerError ? e.code : String(e); }
  return undefined;
};

/** The bytes a database file of the instance really holds, free pages left out, read with a connection of its own. */
function fileBytes(dir: string, instanceId: string, file: 'data' | 'inbox'): number {
  const full = path.join(dir, 'instances', instanceId, `${file}.sqlite`);
  if (!fs.existsSync(full)) return 0;
  const db = new DatabaseSync(full, { readOnly: true });
  const n = (pragma: string): number => Number((db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma]);
  const bytes = (n('page_count') - n('freelist_count')) * n('page_size');
  db.close();
  return bytes;
}

const FROM_OUTSIDE = { by: null, rotate: false };
const ROTATING = { by: null, rotate: true };

describe('documents from outside in the store', () => {
  it('are documents like any other to whoever reads: get, query, export, live updates', () => {
    const { store, hub } = make();
    store.set('i1', 'hits/own', { mine: true }, 'u1');
    const events: HubEvent[] = [];
    hub.subscribe('i1', (e) => events.push(e));
    const doc = store.ingest('i1', 'hits/a1', { path: '/' }, FROM_OUTSIDE);
    expect(doc).toMatchObject({ path: 'hits/a1', id: 'a1', data: { path: '/' }, version: 1, updatedBy: null });
    expect(store.get('i1', 'hits/a1')?.data).toEqual({ path: '/' });
    expect(store.query('i1', 'hits').map((d) => d.id)).toEqual(['a1', 'own']);
    expect(store.query('i1', 'hits', { where: [['path', '==', '/']] })).toHaveLength(1);
    expect(store.query('i1', 'hits', { limit: 1 }).map((d) => d.id)).toEqual(['a1']);
    expect([...store.exportDocs('i1')]).toEqual([{ path: 'hits/a1', data: { path: '/' } }, { path: 'hits/own', data: { mine: true } }]);
    expect(events).toEqual([{ type: 'change', path: 'hits/a1', parent: 'hits' }]);
  });

  it('only ever add: an id that exists, in either place, is not overwritten', () => {
    const { store } = make();
    store.set('i1', 'hits/a1', { mine: true }, 'u1');
    expect(code(() => store.ingest('i1', 'hits/a1', { theirs: true }, FROM_OUTSIDE))).toBe('conflict');
    expect(store.get('i1', 'hits/a1')?.data).toEqual({ mine: true });
    store.ingest('i1', 'hits/b1', { first: true }, FROM_OUTSIDE);
    expect(code(() => store.ingest('i1', 'hits/b1', { second: true }, ROTATING))).toBe('conflict');
    expect(store.get('i1', 'hits/b1')?.data).toEqual({ first: true });
  });

  it('are held to the rules for paths and documents, and leave nothing behind when refused', () => {
    const { store } = make();
    expect(code(() => store.ingest('i1', 'hits', { a: 1 }, FROM_OUTSIDE))).toBe('invalid_argument');
    expect(code(() => store.ingest('i1', 'hits/../x', { a: 1 }, FROM_OUTSIDE))).toBe('invalid_argument');
    expect(code(() => store.ingest('i1', 'hits/a', [1] as never, FROM_OUTSIDE))).toBe('invalid_argument');
    expect(code(() => store.ingest('i1', 'hits/a', { n: Infinity }, FROM_OUTSIDE))).toBe('invalid_argument');
    expect(store.hasData('i1')).toBe(false);
  });

  it('are refused altogether when the server takes no data from outside', () => {
    const { store } = make(0);
    expect(code(() => store.ingest('i1', 'hits/a', { a: 1 }, ROTATING))).toBe('quota_exceeded');
    expect(store.hasData('i1')).toBe(false);
  });

  it('lie in a file of their own: the instance\'s own storage does not grow by a byte', () => {
    const { store, dir } = make();
    store.set('i1', 'notes/n1', { text: 'x'.repeat(5000) }, 'u1');
    const own = store.usage('i1');
    expect(store.ingestUsage('i1')).toBe(0);
    for (let i = 0; i < 300; i++) store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(700), n: i }, FROM_OUTSIDE);
    expect(store.usage('i1')).toBe(own);
    expect(fileBytes(dir, 'i1', 'data')).toBe(own);
    // What is reported for them is what their file holds, less the pages of its empty tables.
    expect(store.ingestUsage('i1')).toBeGreaterThan(300 * 700);
    expect(store.ingestUsage('i1')).toBe(fileBytes(dir, 'i1', 'inbox') - 6 * 4096);
  });

  it('an instance that never received anything has no inbox file and reports none', () => {
    const { store, dir } = make();
    store.set('i1', 'notes/n1', { a: 1 }, 'u1');
    expect(store.query('i1', 'notes')).toHaveLength(1);
    expect(store.ingestUsage('i1')).toBe(0);
    expect(fs.existsSync(path.join(dir, 'instances', 'i1', 'inbox.sqlite'))).toBe(false);
    // The first document from outside creates it, with nothing counted for the empty tables.
    store.ingest('i1', 'hits/a', { a: 1 }, FROM_OUTSIDE);
    store.delete('i1', 'hits/a');
    expect(fs.existsSync(path.join(dir, 'instances', 'i1', 'inbox.sqlite'))).toBe(true);
    expect(store.ingestUsage('i1')).toBe(0);
  });

  it('a full ingest quota refuses further documents and nothing else', () => {
    const { store, dir } = make(64 * KiB);
    let stored = 0;
    while (code(() => store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(900) }, FROM_OUTSIDE)) === undefined) stored++;
    expect(stored).toBeGreaterThan(20);
    expect(store.ingestUsage('i1')).toBeLessThanOrEqual(64 * KiB);
    expect(code(() => store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(900) }, FROM_OUTSIDE))).toBe('quota_exceeded');
    // A document larger than the whole quota is refused even where older ones may go, and they stay.
    expect(code(() => store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(100_000) }, ROTATING))).toBe('quota_exceeded');
    expect(store.query('i1', 'hits')).toHaveLength(stored);
    expect(fileBytes(dir, 'i1', 'inbox') - 6 * 4096).toBeLessThanOrEqual(64 * KiB);
    // The instance's own writes go on.
    expect(code(() => store.set('i1', 'notes/n1', { text: 'x'.repeat(100_000) }, 'u1'))).toBeUndefined();
  });

  it('a full instance refuses the owner\'s writes and still takes documents from outside', () => {
    const { store } = make(MiB, 200_000);
    while (code(() => store.set('i1', `notes/${newDocId()}`, { text: 'x'.repeat(20_000) }, 'u1')) === undefined) { /* fill */ }
    expect(code(() => store.set('i1', 'notes/more', { a: 1 }, 'u1'))).toBe('quota_exceeded');
    expect(code(() => store.ingest('i1', `hits/${newDocId()}`, { a: 1 }, FROM_OUTSIDE))).toBeUndefined();
    // What the instance holds itself is still what decides about its own writes.
    for (const d of store.query('i1', 'notes', { limit: 3 })) store.delete('i1', d.path);
    expect(code(() => store.set('i1', 'notes/more', { a: 1 }, 'u1'))).toBeUndefined();
  });

  it('rotation drops the oldest received documents of the same collection, and only those', () => {
    const { store } = make(64 * KiB);
    store.ingest('i1', 'messages/m1', { text: 'keep me' }, FROM_OUTSIDE);
    store.set('i1', 'hits/own', { mine: true }, 'u1');
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) { ids.push(`h${String(i).padStart(3, '0')}`); store.ingest('i1', `hits/${ids[i]}`, { text: 'x'.repeat(900) }, ROTATING); }
    const left = store.query('i1', 'hits').map((d) => d.id).filter((id) => id !== 'own');
    expect(left.length).toBeGreaterThan(20);
    expect(left.length).toBeLessThan(80);
    // The newest ones stayed, without a gap.
    expect(left).toEqual(ids.slice(300 - left.length));
    expect(store.get('i1', 'messages/m1')).not.toBeNull();
    expect(store.get('i1', 'hits/own')).not.toBeNull();
    expect(store.ingestUsage('i1')).toBeLessThanOrEqual(64 * KiB);
    // With nothing of its own to drop, a rotating collection is refused like any other.
    expect(code(() => store.ingest('i1', `other/${newDocId()}`, { text: 'x'.repeat(60_000) }, ROTATING))).toBe('quota_exceeded');
    expect(left.every((id) => store.get('i1', `hits/${id}`) !== null)).toBe(true);
  });

  it('a full rotating collection announces a burst once, not every document it drops', () => {
    const { store, hub } = make(64 * KiB);
    for (let i = 0; i < 200; i++) store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(900) }, ROTATING);
    const events: HubEvent[] = [];
    hub.subscribe('i1', (e) => events.push(e));
    for (let i = 0; i < 100; i++) store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(900) }, ROTATING);
    // At most the notice that was already pending; the rest comes as one when the interval is over.
    expect(events.length).toBeLessThanOrEqual(1);
  });

  it('a received document that is changed stays a received one, within the ingest quota', () => {
    const { store } = make(64 * KiB);
    store.set('i1', 'notes/n1', { a: 1 }, 'u1');
    const own = store.usage('i1');
    store.ingest('i1', 'wall/a', { text: 'hi' }, FROM_OUTSIDE);
    const updated = store.update('i1', 'wall/a', { approved: true }, 'u1');
    expect(updated).toMatchObject({ data: { text: 'hi', approved: true }, version: 2, updatedBy: 'u1' });
    expect(store.set('i1', 'wall/a', { text: 'replaced' }, 'u1')).toMatchObject({ data: { text: 'replaced' }, version: 3 });
    expect(store.acquire('i1', 'wall/a', { holder: 'me', data: { locked: true } }, 'u1')).toMatchObject({ acquired: true, version: 4 });
    expect(store.get('i1', 'wall/a')?.data).toEqual({ text: 'replaced', locked: true });
    expect(store.query('i1', 'wall')).toHaveLength(1);
    expect(store.usage('i1')).toBe(own);
    // Growing it beyond the quota is refused and changes nothing; the instance's own storage is not where it would go.
    expect(code(() => store.update('i1', 'wall/a', { big: 'x'.repeat(200_000) }, 'u1'))).toBe('quota_exceeded');
    expect(code(() => store.acquire('i1', 'wall/a', { holder: 'me', data: { big: 'x'.repeat(200_000) } }, 'u1'))).toBe('quota_exceeded');
    expect(store.get('i1', 'wall/a')?.data).toEqual({ text: 'replaced', locked: true });
    expect(store.usage('i1')).toBe(own);
    // Deleting it makes the room free again.
    expect(store.delete('i1', 'wall/a')).toBe(true);
    expect(store.get('i1', 'wall/a')).toBeNull();
    expect(store.ingestUsage('i1')).toBe(0);
    expect(store.delete('i1', 'wall/a')).toBe(false);
  });

  it('an import replaces a received document where it lies', () => {
    const { store } = make(64 * KiB);
    store.set('i1', 'notes/n1', { a: 1 }, 'u1');
    store.ingest('i1', 'hits/a', { n: 1, text: 'x'.repeat(3000) }, FROM_OUTSIDE);
    store.ingest('i1', 'hits/z', { n: 9, text: 'x'.repeat(3000) }, FROM_OUTSIDE);
    const own = store.usage('i1');
    const received = store.ingestUsage('i1');
    expect(received).toBeGreaterThan(0);
    store.importDocs('i1', [{ path: 'hits/a', data: { n: 2, text: 'y'.repeat(3000) } }], 'u1');
    expect(store.get('i1', 'hits/a')).toMatchObject({ data: { n: 2 }, version: 2, updatedBy: 'u1' });
    // It was not copied into the instance's own storage, and the inbox holds what it held.
    expect(store.usage('i1')).toBe(own);
    expect(store.ingestUsage('i1')).toBe(received);
    // A path that is new goes where the instance's own documents go.
    store.importDocs('i1', [{ path: 'hits/b', data: { n: 3 } }], 'u1');
    expect(store.ingestUsage('i1')).toBe(received);
    expect(store.query('i1', 'hits').map((d) => [d.id, d.data.n, d.version])).toEqual([['a', 2, 2], ['b', 3, 1], ['z', 9, 1]]);
    expect([...store.exportDocs('i1')].map((d) => d.path)).toEqual(['hits/a', 'hits/b', 'hits/z', 'notes/n1']);
    // An import that would grow the inbox beyond its quota is refused as a whole.
    expect(code(() => store.importDocs('i1', [{ path: 'notes/n9', data: { a: 1 } }, { path: 'hits/a', data: { text: 'x'.repeat(200_000) } }], 'u1'))).toBe('quota_exceeded');
    expect(store.get('i1', 'notes/n9')).toBeNull();
    expect(store.get('i1', 'hits/a')?.data.n).toBe(2);
  });

  it('snapshots hold the instance\'s own documents; a restore leaves what came from outside as it is', () => {
    const { store } = make();
    store.set('i1', 'notes/n1', { v: 1 }, 'u1');
    store.ingest('i1', 'hits/a', { n: 1 }, FROM_OUTSIDE);
    const snap = store.snapshot('i1', 'before')!;
    store.set('i1', 'notes/n1', { v: 2 }, 'u1');
    store.ingest('i1', 'hits/b', { n: 2 }, FROM_OUTSIDE);
    store.restore('i1', snap.id);
    expect(store.get('i1', 'notes/n1')?.data).toEqual({ v: 1 });
    // Every received document is there under its path, once.
    expect(store.query('i1', 'hits').map((d) => d.id)).toEqual(['a', 'b']);
    expect([...store.exportDocs('i1')].map((d) => d.path)).toEqual(['hits/a', 'hits/b', 'notes/n1']);
    // And it goes on taking documents afterwards.
    store.ingest('i1', 'hits/c', { n: 3 }, FROM_OUTSIDE);
    expect(store.query('i1', 'hits')).toHaveLength(3);
  });

  it('a database from before this feature takes documents from outside and keeps its own', () => {
    const { store, dir } = make();
    fs.mkdirSync(path.join(dir, 'instances', 'old'), { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'instances', 'old', 'data.sqlite'));
    db.exec(`CREATE TABLE docs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL,
      created_at TEXT, updated_at TEXT, updated_by TEXT, lease_holder TEXT, lease_expires TEXT);
      INSERT INTO docs (path, parent, id, data, version) VALUES ('notes/n1', 'notes', 'n1', '{"a":1}', 1);`);
    db.close();
    expect(store.ingestUsage('old')).toBe(0);
    expect(store.get('old', 'notes/n1')?.data).toEqual({ a: 1 });
    store.ingest('old', 'hits/a', { n: 1 }, FROM_OUTSIDE);
    expect(store.get('old', 'notes/n1')?.data).toEqual({ a: 1 });
    expect(store.get('old', 'hits/a')?.data).toEqual({ n: 1 });
  });

  it('the inbox goes to the trash with the instance', () => {
    const { store, dir } = make();
    store.ingest('i1', 'hits/a', { n: 1 }, FROM_OUTSIDE);
    store.trash('i1');
    expect(fs.existsSync(path.join(dir, 'instances', 'i1'))).toBe(false);
    const [moved] = fs.readdirSync(path.join(dir, 'trash'));
    expect(fs.readdirSync(path.join(dir, 'trash', moved))).toContain('inbox.sqlite');
    expect(store.get('i1', 'hits/a')).toBeNull();
  });

  it('a signed-in visitor who appends is remembered as an author', () => {
    const { store } = make();
    store.ingest('i1', 'rsvps/a', { name: 'Ada' }, { by: 'u7', rotate: false });
    expect(store.get('i1', 'rsvps/a')?.updatedBy).toBe('u7');
    expect(store.hasAuthor('i1', 'u7')).toBe(true);
  });
});

describe('the ingest quota is a wall', () => {
  // Whoever sends chooses the sizes and the order. Whatever they choose, the inbox must stay within the quota, measured in
  // the pages its file really holds, and the instance's own database must not change at all.
  it.each([
    ['tiny hits', 40], ['small events', 300], ['just under half a page', 1800], ['just over half a page', 1900],
    ['a page', 3900], ['spilling over', 4200], ['two pages', 9000], ['the largest request', 64 * 1024],
  ])('holds for every document size while a collection rotates: %s', (_label, size) => {
    const quota = MiB;
    const { store, dir } = make(quota);
    store.set('i1', 'notes/n1', { a: 1 }, 'u1');
    const own = fileBytes(dir, 'i1', 'data');
    const text = 'x'.repeat(size);
    const rounds = Math.max(60, Math.ceil((3 * quota) / (size + 200)));
    let peak = 0;
    for (let i = 0; i < rounds; i++) {
      store.ingest('i1', `hits/${newDocId()}`, { text }, ROTATING);
      if (i % 25 === 0 || i === rounds - 1) peak = Math.max(peak, fileBytes(dir, 'i1', 'inbox') - 6 * 4096);
    }
    expect(peak).toBeLessThanOrEqual(quota);
    // Rotation keeps the collection well filled: it is not emptied to make room.
    expect(store.ingestUsage('i1')).toBeGreaterThan(quota / 2);
    expect(fileBytes(dir, 'i1', 'data')).toBe(own);
    expect(store.usage('i1')).toBe(own);
  }, 60_000);

  it('holds when two collections are fed in turn and only one rotates, and then small documents push the fillers out', () => {
    // Rows of one collection deleted from between rows of another used to leave half-empty pages that nothing accounted for.
    const quota = MiB;
    const { store, dir } = make(quota);
    store.set('i1', 'notes/n1', { a: 1 }, 'u1');
    const own = store.usage('i1');
    const refusedAt: number[] = [];
    // Once the collection that does not rotate holds all the room, the other one has nothing left to drop and is refused too.
    for (let i = 0; i < 1500; i++) {
      if (code(() => store.ingest('i1', `kept/${newDocId()}`, { text: 'x'.repeat(1800) }, FROM_OUTSIDE)) !== undefined) refusedAt.push(i);
      code(() => store.ingest('i1', `filler/${newDocId()}`, { text: 'x'.repeat(1900) }, ROTATING));
    }
    for (let i = 0; i < 3000; i++) {
      code(() => store.ingest('i1', `filler/${newDocId()}`, { t: 1 }, ROTATING));
      if (i % 3 === 0) code(() => store.ingest('i1', `kept/${newDocId()}`, { text: 'x'.repeat(1800) }, FROM_OUTSIDE));
    }
    expect(refusedAt.length).toBeGreaterThan(0);
    expect(fileBytes(dir, 'i1', 'inbox') - 6 * 4096).toBeLessThanOrEqual(quota);
    expect(store.ingestUsage('i1')).toBeLessThanOrEqual(quota);
    expect(store.usage('i1')).toBe(own);
    expect(fileBytes(dir, 'i1', 'data')).toBe(own);
    // The instance's own writes are as possible as before.
    expect(code(() => store.set('i1', 'notes/n2', { text: 'x'.repeat(100_000) }, 'u1'))).toBeUndefined();
  }, 60_000);

  it('documents of the instance written while documents arrive are not spread over the inbox\'s pages', () => {
    const { store } = make(256 * KiB);
    for (let i = 0; i < 400; i++) {
      store.set('i1', `notes/n${i}`, { text: 'x'.repeat(600) }, 'u1');
      store.ingest('i1', `hits/${newDocId()}`, { text: 'x'.repeat(1200) }, ROTATING);
    }
    const mixed = store.usage('i1');
    // The same documents written without anything arriving take the same room.
    const { store: alone } = make(256 * KiB);
    for (let i = 0; i < 400; i++) alone.set('i1', `notes/n${i}`, { text: 'x'.repeat(600) }, 'u1');
    expect(mixed).toBe(alone.usage('i1'));
    alone.close();
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
