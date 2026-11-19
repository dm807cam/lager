import type { DatabaseSync } from 'node:sqlite';

/** How many instance databases one store keeps open at a time; every handle holds file descriptors (database, WAL, shared memory). */
export const MAX_OPEN_HANDLES = 64;

/**
 * The open SQLite handles of a store, least recently used first. Beyond `max` the least recently used one is closed
 * (SQLite checkpoints the WAL when the last connection closes); the store reopens it on the next use.
 *
 * Closing is safe because every use is synchronous and starts with a lookup here, which makes that handle the most recently
 * used one: the handle a running statement or transaction works on is never the one evicted. Nothing may keep a handle
 * across an `await` or a `yield`; long-running readers (the export) fetch it again for every batch.
 */
export class HandleCache {
  private dbs = new Map<string, DatabaseSync>();

  constructor(private max = MAX_OPEN_HANDLES) {}

  get size(): number {
    return this.dbs.size;
  }

  get(id: string): DatabaseSync | undefined {
    const db = this.dbs.get(id);
    if (db) {
      this.dbs.delete(id);
      this.dbs.set(id, db);
    }
    return db;
  }

  set(id: string, db: DatabaseSync): void {
    this.dbs.set(id, db);
    while (this.dbs.size > Math.max(2, this.max)) this.close(this.dbs.keys().next().value as string);
  }

  close(id: string): void {
    this.dbs.get(id)?.close();
    this.dbs.delete(id);
  }

  closeAll(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}
