import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('acquire grants, refuses, expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const a = store.acquire('i1', 'locks/l1', { holder: 'A', ttlMs: 1000, data: { owner: 'A' } }, null);
    expect(a.acquired).toBe(true);
    expect(store.get('i1', 'locks/l1')!.data).toEqual({ owner: 'A' });
    const b = store.acquire('i1', 'locks/l1', { holder: 'B', ttlMs: 1000 }, null);
    expect(b).toMatchObject({ acquired: false, holder: 'A' });
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
