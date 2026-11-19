import { describe, expect, it } from 'vitest';
import { LagerError } from '../src/errors.js';
import { Rooms, ROOM_LIMITS, type RoomEvent } from '../src/data/rooms.js';

const viewer = (by: string | null = 'u1') => ({ by, guest: by === null });

function join(rooms: Rooms, room = '', by: string | null = 'u1', instance = 'i1') {
  const events: RoomEvent[] = [];
  const conn = rooms.connect(instance, room, viewer(by), (e) => events.push(e));
  return { ...conn, events };
}

const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof LagerError ? e.code : 'other'; }
  return 'none';
};

describe('Rooms', () => {
  it('peers see each other and messages', () => {
    const rooms = new Rooms();
    const a = join(rooms, '', 'u1');
    const b = join(rooms, '', null);
    // a learns about b; the identity comes from the server-side viewer
    const joined = a.events.find((e) => e.type === 'peers');
    expect(joined).toMatchObject({ type: 'peers', joined: [{ peer: b.peerId, by: null, guest: true, kind: 'viewer' }], left: [], updated: [] });
    expect(rooms.peers('i1', '').map((p) => p.peer).sort()).toEqual([a.peerId, b.peerId].sort());
    a.events.length = 0;
    rooms.emit('i1', '', a.peerId, 'move', { x: 1 });
    for (const c of [a, b]) {
      const m = c.events.filter((e) => e.type === 'message');
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ topic: 'move', data: { x: 1 }, from: { peer: a.peerId, by: 'u1', guest: false } });
    }
  });

  it('presence patch merges and null deletes', () => {
    const rooms = new Rooms();
    const a = join(rooms, '', 'u1');
    const b = join(rooms, '', 'u2');
    b.events.length = 0;
    rooms.setPresence('i1', '', a.peerId, { cursor: { x: 1 }, mode: 'draw' });
    rooms.setPresence('i1', '', a.peerId, { mode: null, color: 'red' });
    const upd = b.events.filter((e) => e.type === 'peers');
    expect(upd).toHaveLength(2);
    expect(upd[1]).toMatchObject({ updated: [{ peer: a.peerId, presence: { cursor: { x: 1 }, color: 'red' } }] });
    expect(rooms.peers('i1', '').find((p) => p.peer === a.peerId)!.presence).toEqual({ cursor: { x: 1 }, color: 'red' });
    // state is cleared when the peer leaves
    b.events.length = 0;
    a.leave();
    expect(b.events).toEqual([{ type: 'peers', joined: [], left: [expect.objectContaining({ peer: a.peerId, presence: { cursor: { x: 1 }, color: 'red' } })], updated: [] }]);
    expect(rooms.peers('i1', '').map((p) => p.peer)).toEqual([b.peerId]);
  });

  it('a __proto__ key in a patch is stored as data and does not pollute', () => {
    const rooms = new Rooms();
    const a = join(rooms);
    rooms.setPresence('i1', '', a.peerId, JSON.parse('{"__proto__":{"admin":true}}') as Record<string, unknown>);
    const p = rooms.peers('i1', '')[0];
    expect(Object.getPrototypeOf(p.presence)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.keys(p.presence)).toEqual(['__proto__']);
  });

  it('rooms are separate and vanish when empty', () => {
    const rooms = new Rooms();
    const lobby = join(rooms, '');
    const x = join(rooms, 'x');
    const other = join(rooms, 'x', 'u1', 'i2');
    lobby.events.length = 0; other.events.length = 0;
    rooms.emit('i1', 'x', x.peerId, 't', 1);
    expect(lobby.events).toEqual([]);
    expect(other.events).toEqual([]);
    expect(rooms.peers('i1', 'x')).toHaveLength(1);
    x.leave();
    expect(rooms.peers('i1', 'x')).toEqual([]);
    // leaving twice is harmless; the vanished room no longer takes emits
    x.leave();
    expect(code(() => rooms.emit('i1', 'x', x.peerId, 't', 1))).toBe('not_found');
  });

  it('peers events carry deltas only and each event is serialized once', () => {
    const rooms = new Rooms();
    const seen: string[] = [];
    const a = rooms.connect('i1', '', viewer(), (_e, json) => seen.push(json));
    const b = rooms.connect('i1', '', viewer('u2'), (_e, json) => seen.push(json));
    rooms.setPresence('i1', '', a.peerId, { x: 1 });
    rooms.emit('i1', '', b.peerId, 't', 1);
    expect(seen).toHaveLength(1 + 2 + 2); // a hears b join; both hear the presence delta and the message
    expect(Object.keys(JSON.parse(seen[0])).sort()).toEqual(['joined', 'left', 'updated']);
    expect(Object.keys(JSON.parse(seen[1])).sort()).toEqual(['joined', 'left', 'updated']);
    expect(seen[1]).toBe(seen[2]); // the very same string for every receiver
    expect(Object.keys(JSON.parse(seen[3])).sort()).toEqual(['data', 'from', 'topic']);
    expect(seen[3]).toBe(seen[4]);
  });

  it('limits are the agreed ones', () => {
    expect(ROOM_LIMITS).toEqual({ maxRoomsPerInstance: 50, maxPeersPerRoom: 100, maxPresenceBytes: 2048, maxMessageBytes: 4096, maxRoomNameLength: 64 });
  });

  it('a throwing receiver does not break the others', () => {
    const rooms = new Rooms();
    rooms.connect('i1', '', viewer(), () => { throw new Error('boom'); });
    const b = join(rooms);
    const a = join(rooms);
    b.events.length = 0;
    rooms.emit('i1', '', a.peerId, 't', null);
    expect(b.events).toHaveLength(1);
  });

  it('limits', () => {
    const rooms = new Rooms();
    for (let i = 0; i < ROOM_LIMITS.maxRoomsPerInstance; i++) join(rooms, `r${i}`);
    expect(code(() => join(rooms, 'one-too-many'))).toBe('conflict');
    // another instance has its own budget, and an existing room still takes peers
    expect(code(() => join(rooms, 'one-too-many', 'u1', 'i2'))).toBe('none');
    expect(code(() => join(rooms, 'r0'))).toBe('none');

    const full = new Rooms();
    for (let i = 0; i < ROOM_LIMITS.maxPeersPerRoom; i++) join(full, 'p');
    expect(code(() => join(full, 'p'))).toBe('conflict');
    // a rejected connect leaves nothing behind
    expect(full.peers('i1', 'p')).toHaveLength(ROOM_LIMITS.maxPeersPerRoom);

    const a = join(rooms, 'r0');
    expect(code(() => rooms.setPresence('i1', 'r0', a.peerId, { big: 'x'.repeat(ROOM_LIMITS.maxPresenceBytes) }))).toBe('invalid_argument');
    // the merged state counts, not just the patch
    rooms.setPresence('i1', 'r0', a.peerId, { a: 'x'.repeat(1500) });
    expect(code(() => rooms.setPresence('i1', 'r0', a.peerId, { b: 'y'.repeat(1000) }))).toBe('invalid_argument');
    expect(rooms.peers('i1', 'r0').find((p) => p.peer === a.peerId)!.presence).toEqual({ a: 'x'.repeat(1500) });
    expect(code(() => rooms.emit('i1', 'r0', a.peerId, 't', 'x'.repeat(ROOM_LIMITS.maxMessageBytes)))).toBe('invalid_argument');
    expect(code(() => rooms.emit('i1', 'r0', a.peerId, 't', 'x'.repeat(1000)))).toBe('none');
    expect(code(() => rooms.emit('i1', 'r0', a.peerId, '', 1))).toBe('invalid_argument');
    expect(code(() => rooms.setPresence('i1', 'r0', a.peerId, [] as never))).toBe('invalid_argument');
    for (const bad of ['a b', 'x'.repeat(65), 'ä', 'a/b', '..?']) {
      expect(code(() => join(rooms, bad))).toBe('invalid_argument');
    }
    expect(code(() => join(rooms, 'x'.repeat(64)))).toBe('conflict'); // valid name, but the instance is full
    expect(code(() => join(rooms, 'A.b_c-1', 'u1', 'i3'))).toBe('none');
  });

  it('emit from an unknown peer is refused', () => {
    const rooms = new Rooms();
    const a = join(rooms, 'x');
    expect(code(() => rooms.emit('i1', 'x', 'nope', 't', 1))).toBe('not_found');
    expect(code(() => rooms.setPresence('i1', 'x', 'nope', { a: 1 }))).toBe('not_found');
    // a peer id is only valid in its own room and instance
    expect(code(() => rooms.emit('i1', '', a.peerId, 't', 1))).toBe('not_found');
    expect(code(() => rooms.emit('i2', 'x', a.peerId, 't', 1))).toBe('not_found');
  });
});
