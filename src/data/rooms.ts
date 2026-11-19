import crypto from 'node:crypto';
import { LagerError } from '../errors.js';

export interface PeerInfo { peer: string; by: string | null; guest: boolean; kind: 'viewer'; presence: Record<string, unknown>; updatedAt: number }
export type RoomEvent =
  | { type: 'message'; topic: string; data: unknown; from: PeerInfo }
  | { type: 'peers'; joined: PeerInfo[]; left: PeerInfo[]; updated: PeerInfo[] };

export const ROOM_LIMITS = {
  maxRoomsPerInstance: 50, maxPeersPerRoom: 100, maxPresenceBytes: 2048, maxMessageBytes: 4096, maxRoomNameLength: 64,
} as const;

const ROOM_NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_TOPIC_LENGTH = 64;

/** Receives each event with its JSON payload (the event without `type`), serialized once for all receivers. */
export type RoomSend = (e: RoomEvent, json: string) => void;
interface Member { info: PeerInfo; send: RoomSend }

/** The lobby is `""`; every other name is 1..64 characters of `[A-Za-z0-9._-]`. */
export function assertRoomName(room: unknown): asserts room is string {
  if (typeof room !== 'string') throw new LagerError('invalid_argument', 'room must be a string.');
  if (room === '') return;
  if (room.length > ROOM_LIMITS.maxRoomNameLength || !ROOM_NAME_RE.test(room)) {
    throw new LagerError('invalid_argument', `A room name has 1 to ${ROOM_LIMITS.maxRoomNameLength} characters of letters, digits, . _ -.`);
  }
}

/** Serialized size of `value` in bytes; throws `invalid_argument` for values JSON cannot carry. */
function jsonBytes(value: unknown, what: string): number {
  let s: string | undefined;
  try { s = JSON.stringify(value); } catch { throw new LagerError('invalid_argument', `${what} is not serializable as JSON.`); }
  return s === undefined ? 0 : Buffer.byteLength(s);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Ephemeral rooms and presence, in memory only. A room exists while it has peers. The identity of a peer
 * (`by`, `guest`) is what the caller passes to `connect`, i.e. the server-side viewer, never client input.
 */
export class Rooms {
  /** instance id -> room name -> peer id -> member */
  private byInstance = new Map<string, Map<string, Map<string, Member>>>();

  connect(
    instanceId: string, room: string, peer: { by: string | null; guest: boolean }, send: RoomSend,
  ): { peerId: string; leave(): void } {
    assertRoomName(room);
    let rooms = this.byInstance.get(instanceId);
    let members = rooms?.get(room);
    if (!members && (rooms?.size ?? 0) >= ROOM_LIMITS.maxRoomsPerInstance) {
      throw new LagerError('conflict', 'Too many rooms in this instance.');
    }
    if (members && members.size >= ROOM_LIMITS.maxPeersPerRoom) throw new LagerError('conflict', 'This room is full.');
    if (!rooms) this.byInstance.set(instanceId, (rooms = new Map()));
    if (!members) rooms.set(room, (members = new Map()));
    const peerId = crypto.randomBytes(12).toString('base64url');
    const info: PeerInfo = { peer: peerId, by: peer.by, guest: peer.guest, kind: 'viewer', presence: Object.create(null) as Record<string, unknown>, updatedAt: Date.now() };
    const others = [...members.values()];
    members.set(peerId, { info, send });
    // The joiner learns the current state from its hello; the others hear about the joiner.
    this.broadcast(others, { type: 'peers', joined: [this.view(info)], left: [], updated: [] });
    let left = false;
    return {
      peerId,
      leave: () => {
        if (left) return;
        left = true;
        const m = this.byInstance.get(instanceId)?.get(room);
        if (!m?.delete(peerId)) return;
        const gone = this.view(info);
        if (m.size === 0) {
          const r = this.byInstance.get(instanceId)!;
          r.delete(room);
          if (r.size === 0) this.byInstance.delete(instanceId);
          return;
        }
        this.broadcast([...m.values()], { type: 'peers', joined: [], left: [gone], updated: [] });
      },
    };
  }

  emit(instanceId: string, room: string, peerId: string, topic: string, data: unknown): void {
    const members = this.members(instanceId, room);
    const from = members.get(peerId);
    if (!from) throw new LagerError('not_found', 'Unknown peer.');
    if (typeof topic !== 'string' || topic === '' || topic.length > MAX_TOPIC_LENGTH) {
      throw new LagerError('invalid_argument', `topic must be a string of 1 to ${MAX_TOPIC_LENGTH} characters.`);
    }
    if (jsonBytes(data, 'data') >= ROOM_LIMITS.maxMessageBytes) {
      throw new LagerError('invalid_argument', `A message has at most ${ROOM_LIMITS.maxMessageBytes} bytes.`);
    }
    this.broadcast([...members.values()], { type: 'message', topic, data, from: this.view(from.info) });
  }

  setPresence(instanceId: string, room: string, peerId: string, patch: Record<string, unknown | null>): void {
    const members = this.members(instanceId, room);
    const me = members.get(peerId);
    if (!me) throw new LagerError('not_found', 'Unknown peer.');
    if (!isPlainObject(patch)) throw new LagerError('invalid_argument', 'patch must be an object.');
    const next = Object.create(null) as Record<string, unknown>;
    Object.assign(next, me.info.presence);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else Object.defineProperty(next, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    if (jsonBytes(next, 'presence') > ROOM_LIMITS.maxPresenceBytes) {
      throw new LagerError('invalid_argument', `Presence has at most ${ROOM_LIMITS.maxPresenceBytes} bytes.`);
    }
    me.info.presence = next;
    me.info.updatedAt = Date.now();
    this.broadcast([...members.values()], { type: 'peers', joined: [], left: [], updated: [this.view(me.info)] });
  }

  peers(instanceId: string, room: string): PeerInfo[] {
    return this.snapshot(this.byInstance.get(instanceId)?.get(room) ?? new Map());
  }

  /** Whether `userId` is in any room of the instance right now. */
  hasUser(instanceId: string, userId: string): boolean {
    for (const members of this.byInstance.get(instanceId)?.values() ?? []) {
      for (const m of members.values()) if (m.info.by === userId) return true;
    }
    return false;
  }

  private members(instanceId: string, room: string): Map<string, Member> {
    return this.byInstance.get(instanceId)?.get(room) ?? new Map();
  }

  /** A copy with plain-object presence, safe to hand out. */
  private view(info: PeerInfo): PeerInfo {
    return { ...info, presence: { ...info.presence } };
  }

  private snapshot(members: Map<string, Member>): PeerInfo[] {
    return [...members.values()].map((m) => this.view(m.info));
  }

  private broadcast(to: Member[], e: RoomEvent): void {
    if (to.length === 0) return;
    const { type: _type, ...payload } = e;
    const json = JSON.stringify(payload);
    for (const m of to) {
      try { m.send(e, json); } catch { /* a failing receiver must never break the others */ }
    }
  }
}
