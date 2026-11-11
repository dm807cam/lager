/** Everything one viewer (a user id, or the client IP of a guest) holds on one instance. */
export interface Viewer {
  guest: boolean;
  streams: number;
  /** room name -> open streams in it */
  rooms: Map<string, number>;
  /** POST budget, shared by all streams of the viewer. */
  tokens: number;
  refilledAt: number;
}

export interface StreamLimits {
  perViewer: number;
  roomsPerViewer: number;
  guestTotal: number;
  /** POST budget per second; records of viewers without streams are dropped once it is full again. */
  postsPerSecond: number;
}

/** Admission control for long-lived event streams: per viewer, per room and for all guests of an instance. */
export class StreamLimiter {
  private readonly viewers = new Map<string, Viewer>();
  private readonly guestStreams = new Map<string, number>();

  constructor(private readonly limits: StreamLimits) {}

  /** Registers a stream for the viewer, or returns null when one of the limits is reached. */
  admit(instanceId: string, key: string, guest: boolean, room: string): Viewer | null {
    const { postsPerSecond } = this.limits;
    const id = `${instanceId}\n${key}`;
    let v = this.viewers.get(id);
    if (!v) {
      const now = Date.now();
      for (const [k, o] of this.viewers) if (o.streams === 0 && o.tokens + ((now - o.refilledAt) / 1000) * postsPerSecond >= postsPerSecond) this.viewers.delete(k);
      v = { guest, streams: 0, rooms: new Map(), tokens: postsPerSecond, refilledAt: now };
      this.viewers.set(id, v);
    }
    const tooMany = v.streams >= this.limits.perViewer || (!v.rooms.has(room) && v.rooms.size >= this.limits.roomsPerViewer)
      || (guest && (this.guestStreams.get(instanceId) ?? 0) >= this.limits.guestTotal);
    if (tooMany) return null;
    v.streams += 1;
    v.rooms.set(room, (v.rooms.get(room) ?? 0) + 1);
    if (guest) this.guestStreams.set(instanceId, (this.guestStreams.get(instanceId) ?? 0) + 1);
    return v;
  }

  release(instanceId: string, v: Viewer, room: string): void {
    v.streams -= 1;
    const n = (v.rooms.get(room) ?? 1) - 1;
    if (n <= 0) v.rooms.delete(room); else v.rooms.set(room, n);
    if (v.guest) this.guestStreams.set(instanceId, Math.max(0, (this.guestStreams.get(instanceId) ?? 1) - 1));
  }
}
