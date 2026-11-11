import crypto from 'node:crypto';
import express from 'express';
import type { Response } from 'express';
import type { Core } from '../core.js';
import type { Level } from '../data/rules.js';
import type { RoomEvent } from '../data/rooms.js';
import { LagerError } from '../errors.js';
import type { Instance } from '../platform/apps.js';
import type { Ctx } from './instance.js';

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
  tokens: number;
  refilledAt: number;
}

const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();

function requireDeclared(ctx: Ctx): void {
  const room = ctx.caps.room;
  if (room === undefined || room === null || typeof room !== 'object') throw new LagerError('not_found', 'Diese App nutzt keine Echtzeit-Räume.');
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

  router.get('/__lager/room/events', (req, res) => {
    const first = ctxOf(res);
    requireAccess(first);
    requireDeclared(first);
    const room = req.query.room === undefined ? '' : req.query.room;
    if (typeof room !== 'string') throw new LagerError('invalid_argument', 'room must be a string.');
    const userId = first.viewer.userId;
    const epoch = first.user?.sessionEpoch;
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
      res.end();
    };
    const send = (event: string, payload: unknown): void => {
      if (ended) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (res.writableLength > MAX_BUFFERED_BYTES) stop();
    };
    // Throws (before any header is written) for a bad room name or a full instance or room.
    const conn = core.rooms.connect(first.instance.id, room, { by: userId, guest: userId === null }, (e: RoomEvent) => {
      const { type, ...rest } = e;
      send(type, rest);
    });
    leave = conn.leave;
    peerId = conn.peerId;
    const secret = userId === null ? crypto.randomBytes(24).toString('base64url') : null;
    streams.set(peerId, {
      instanceId: first.instance.id, room, userId, secretHash: secret === null ? null : sha256(secret),
      tokens: POSTS_PER_SECOND, refilledAt: Date.now(),
    });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    send('hello', { peer: peerId, peers: core.rooms.peers(first.instance.id, room), ...(secret === null ? {} : { secret }) });
    /** Whether this stream's session still has access to a room-declaring instance. */
    const stillAllowed = (): boolean => {
      const inst = core.apps.getInstance(first.instance.id);
      const viewer = userId === null ? null : core.users.get(userId);
      // The stream belongs to the session it was opened with: logout, password change or disabling ends it.
      if (userId !== null && (!viewer || viewer.disabled || viewer.sessionEpoch !== epoch)) return false;
      if (!inst || inst.disabled || RANK[core.access.levelFor(inst, viewer)] < RANK.view) return false;
      const decl = activeCapabilities(core, inst).room;
      return decl !== undefined && decl !== null && typeof decl === 'object';
    };
    ping = setInterval(() => {
      if (!stillAllowed()) { stop(); return; }
      res.write(': ping\n\n');
    }, ROOM_PING_MS);
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
    const now = Date.now();
    stream.tokens = Math.min(POSTS_PER_SECOND, stream.tokens + ((now - stream.refilledAt) / 1000) * POSTS_PER_SECOND);
    stream.refilledAt = now;
    if (stream.tokens < 1) {
      res.status(429).set('Retry-After', '1').json({ error: { code: 'rate_limited', message: 'Zu viele Anfragen.' } });
      return;
    }
    stream.tokens -= 1;
    res.set('Cache-Control', 'no-store');
    if (op === 'emit') {
      if (typeof topic !== 'string') throw new LagerError('invalid_argument', 'topic must be a string.');
      if (!mayEmit(ctx, topic)) throw new LagerError('forbidden', 'Keine Berechtigung, hier Ereignisse zu senden.');
      core.rooms.emit(ctx.instance.id, room, peer, topic, data);
    } else {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new LagerError('invalid_argument', 'patch must be an object.');
      core.rooms.setPresence(ctx.instance.id, room, peer, patch as Record<string, unknown>);
    }
    res.json({ ok: true });
  });
}
