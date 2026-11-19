import crypto from 'node:crypto';
import express from 'express';
import type { Response } from 'express';
import type { Core } from '../core.js';
import type { Level } from '../data/rules.js';
import { assertRoomName, type RoomEvent } from '../data/rooms.js';
import { LagerError } from '../errors.js';
import type { Instance } from '../platform/apps.js';
import type { Ctx } from './instance.js';
import { addressKey } from './client-address.js';
import { assertOwnOrigin } from './origin.js';
import { StreamLimiter, type Viewer } from './stream-limit.js';

export const ROOM_PING_MS = 25_000;
const BODY_LIMIT = '128kb';
const POSTS_PER_SECOND = 30;
/** A receiver that lags this far behind is dropped; it reconnects and gets a fresh hello. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const RANK: Record<Level, number> = { none: 0, view: 1, interact: 2, admin: 3, owner: 4 };

interface Stream {
  instanceId: string;
  room: string;
  /** Signed-in viewers are tied to their user id; guests have no id and prove themselves with the stream secret. */
  userId: string | null;
  secretHash: Buffer | null;
  viewer: Viewer;
}

const MAX_STREAMS_PER_VIEWER = 8;
const MAX_ROOMS_PER_VIEWER = 8;
const MAX_GUEST_STREAMS = 100;
export const STREAM_LIMITS = { perViewer: MAX_STREAMS_PER_VIEWER, roomsPerViewer: MAX_ROOMS_PER_VIEWER, guestTotal: MAX_GUEST_STREAMS, postsPerSecond: POSTS_PER_SECOND };

const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();

function requireDeclared(ctx: Ctx): void {
  const room = ctx.caps.room;
  if (room === undefined || room === null || typeof room !== 'object') throw new LagerError('not_found', 'This app does not use realtime rooms.');
}

/** Emitting needs an editor level, or `interact` on a topic the app opened with `topics[topic] === "interact"`. */
function mayEmit(ctx: Ctx, topic: string): boolean {
  const level = ctx.viewer.level;
  if (level === 'admin' || level === 'owner') return true;
  const topics = ctx.caps.room?.topics;
  return level === 'interact' && topics !== undefined && topics !== null && typeof topics === 'object'
    && Object.prototype.hasOwnProperty.call(topics, topic) && topics[topic] === 'interact';
}

/** Mounts the room routes (`/__lager/room/events`, `/__lager/room`) on the instance router. */
export function mountRoomRoutes(
  router: express.Router, core: Core, ctxOf: (res: Response) => Ctx, requireAccess: (ctx: Ctx) => void,
  activeCapabilities: (core: Core, instance: Instance) => Ctx['caps'],
): void {
  const streams = new Map<string, Stream>();
  const limiter = new StreamLimiter(STREAM_LIMITS);

  router.get('/__lager/room/events', (req, res) => {
    assertOwnOrigin(req);
    const first = ctxOf(res);
    requireAccess(first);
    requireDeclared(first);
    const room = req.query.room === undefined ? '' : req.query.room;
    if (typeof room !== 'string') throw new LagerError('invalid_argument', 'room must be a string.');
    assertRoomName(room);
    const userId = first.viewer.userId;
    const epoch = first.user?.sessionEpoch;
    const instanceId = first.instance.id;
    const viewer = limiter.admit(instanceId, userId ?? `ip:${addressKey(req.ip)}`, userId === null, room);
    if (!viewer) {
      res.status(429).set('Retry-After', '5').json({ error: { code: 'rate_limited', message: 'Too many open connections.' } });
      return;
    }
    let ping: NodeJS.Timeout | undefined;
    let ended = false;
    let leave: (() => void) | undefined;
    let peerId = '';
    const stop = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      leave?.();
      streams.delete(peerId);
      limiter.release(instanceId, viewer, room);
      res.end();
    };
    const write = (event: string, json: string): void => {
      if (ended) return;
      res.write(`event: ${event}\ndata: ${json}\n\n`);
      if (res.writableLength > MAX_BUFFERED_BYTES) stop();
    };
    // The identity is the session's; the user id is only revealed to apps that declared the `user` capability.
    const by = userId !== null && typeof first.caps.user === 'object' && first.caps.user !== null ? userId : null;
    let conn: { peerId: string; leave(): void };
    try {
      // Throws (before any header is written) for a bad room name or a full instance or room.
      conn = core.rooms.connect(instanceId, room, { by, guest: userId === null }, (e: RoomEvent, json: string) => write(e.type, json));
    } catch (e) {
      limiter.release(instanceId, viewer, room);
      throw e;
    }
    leave = conn.leave;
    peerId = conn.peerId;
    const secret = userId === null ? crypto.randomBytes(24).toString('base64url') : null;
    streams.set(peerId, { instanceId, room, userId, secretHash: secret === null ? null : sha256(secret), viewer });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    /** Whether this stream's session still has access to a room-declaring instance. */
    const stillAllowed = (): boolean => {
      const inst = core.apps.getInstance(instanceId);
      const viewerUser = userId === null ? null : core.users.get(userId);
      // The stream belongs to the session it was opened with: logout, password change or disabling ends it.
      if (userId !== null && (!viewerUser || viewerUser.disabled || viewerUser.sessionEpoch !== epoch)) return false;
      if (!inst || inst.disabled || RANK[core.access.levelFor(inst, viewerUser)] < RANK.view) return false;
      const decl = activeCapabilities(core, inst).room;
      return decl !== undefined && decl !== null && typeof decl === 'object';
    };
    // Created before the first write: a write can already end the stream, and a timer made after that would never be cleared.
    ping = setInterval(() => {
      if (ended) { clearInterval(ping); return; }
      if (!stillAllowed()) { stop(); return; }
      res.write(': ping\n\n');
    }, ROOM_PING_MS);
    write('hello', JSON.stringify({ peer: peerId, peers: core.rooms.peers(instanceId, room), ...(secret === null ? {} : { secret }) }));
    req.on('close', stop);
  });

  router.post('/__lager/room', express.json({ limit: BODY_LIMIT }), (req, res) => {
    if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
    const ctx = ctxOf(res);
    requireAccess(ctx);
    requireDeclared(ctx);
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new LagerError('invalid_argument', 'Request body must be a JSON object.');
    const { room, peer, op, topic, data, patch, secret } = body as Record<string, unknown>;
    if (typeof room !== 'string') throw new LagerError('invalid_argument', 'room must be a string.');
    if (typeof peer !== 'string') throw new LagerError('invalid_argument', 'peer must be a string.');
    if (op !== 'emit' && op !== 'presence') throw new LagerError('invalid_argument', 'op must be "emit" or "presence".');
    // The peer must be a live stream of this very viewer; nothing from the body names an identity.
    const stream = streams.get(peer);
    const mine = stream !== undefined && stream.instanceId === ctx.instance.id && stream.room === room && (stream.userId !== null
      ? ctx.viewer.userId === stream.userId
      : typeof secret === 'string' && stream.secretHash !== null && crypto.timingSafeEqual(sha256(secret), stream.secretHash));
    if (!mine) throw new LagerError('forbidden', 'Unknown peer.');
    // The budget belongs to the viewer, so opening more streams does not multiply it.
    const bucket = stream.viewer;
    const now = Date.now();
    bucket.tokens = Math.min(POSTS_PER_SECOND, bucket.tokens + ((now - bucket.refilledAt) / 1000) * POSTS_PER_SECOND);
    bucket.refilledAt = now;
    if (bucket.tokens < 1) {
      res.status(429).set('Retry-After', '1').json({ error: { code: 'rate_limited', message: 'Too many requests.' } });
      return;
    }
    bucket.tokens -= 1;
    res.set('Cache-Control', 'no-store');
    if (op === 'emit') {
      if (typeof topic !== 'string') throw new LagerError('invalid_argument', 'topic must be a string.');
      if (!mayEmit(ctx, topic)) throw new LagerError('forbidden', 'You may not send events on this topic.');
      core.rooms.emit(ctx.instance.id, room, peer, topic, data);
    } else {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new LagerError('invalid_argument', 'patch must be an object.');
      core.rooms.setPresence(ctx.instance.id, room, peer, patch as Record<string, unknown>);
    }
    res.json({ ok: true });
  });
}
