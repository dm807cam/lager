import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';
import { HandleCache } from './handles.js';
import type { Hub } from './hub.js';
import { assertCollectionPath, assertDocData, parseDocPath } from './paths.js';
import { queryLimit, runQuery, type QuerySpec } from './query.js';

export interface Doc {
  path: string; id: string; data: Record<string, unknown>; version: number;
  createdAt: string; updatedAt: string; updatedBy: string | null;
}
export interface SnapshotInfo { id: string; label: string; createdAt: string; sizeBytes: number }
export interface AcquireResult { acquired: boolean; version?: number; expiresAt?: string }

interface DocRow {
  path: string; parent: string; id: string; data: string; version: number;
  created_at: string; updated_at: string; updated_by: string | null;
  lease_holder: string | null; lease_expires: string | null;
}

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_RE = /^[a-z0-9-]{1,64}$/;
const SNAPSHOT_FILE_RE = /^(\d{8}T\d{9}Z)-([a-z0-9-]{1,64})\.sqlite$/;
const SNAPSHOT_ID_RE = /^\d{8}T\d{9}Z-[a-z0-9-]{1,64}$/;
const EXPORT_BATCH = 500;
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 300_000;
/** All snapshots of an instance together may take this many times its quota; they do not count against the quota itself. */
export const SNAPSHOT_QUOTA_FACTOR = 3;
/** The newest snapshot at least this old is never pruned, so a burst of new snapshots cannot push out every earlier state. */
export const SNAPSHOT_OLD_MS = 24 * 60 * 60_000;

/** Documents of a deleted account's private area removed from one instance in one call; a larger area takes several (see `PrivatePurge`). */
export const PRIVATE_PURGE_LIMIT = 50_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT,
    updated_at TEXT,
    updated_by TEXT,
    lease_holder TEXT,
    lease_expires TEXT
  );
  CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
`;

/**
 * Documents that came from outside (an ingest endpoint, or a visitor appending under an `anyone` rule) are ordinary documents
 * with one entry each in `ingested`: what they count against the ingest quota, in the order they arrived. The entry goes when
 * the document is deleted or changed by someone with write access, which makes it the instance's own. Triggers keep this and
 * the running total, so no write path can leave the bookkeeping behind.
 */
const INGEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ingested (
    seq INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    parent TEXT NOT NULL,
    bytes INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ingested_parent ON ingested(parent, seq);
  CREATE TABLE IF NOT EXISTS ingest_usage (id INTEGER PRIMARY KEY CHECK (id = 1), bytes INTEGER NOT NULL);
  INSERT OR IGNORE INTO ingest_usage (id, bytes) VALUES (1, 0);
  CREATE TRIGGER IF NOT EXISTS ingested_added AFTER INSERT ON ingested BEGIN UPDATE ingest_usage SET bytes = bytes + NEW.bytes WHERE id = 1; END;
  CREATE TRIGGER IF NOT EXISTS ingested_removed AFTER DELETE ON ingested BEGIN UPDATE ingest_usage SET bytes = bytes - OLD.bytes WHERE id = 1; END;
  CREATE TRIGGER IF NOT EXISTS ingested_doc_deleted AFTER DELETE ON docs BEGIN DELETE FROM ingested WHERE path = OLD.path; END;
  CREATE TRIGGER IF NOT EXISTS ingested_doc_changed AFTER UPDATE ON docs BEGIN DELETE FROM ingested WHERE path = OLD.path; END;
`;

/** Received documents dropped per round when an endpoint that rotates needs room. */
const ROTATE_BATCH = 20;
/** Live queries hear of documents arriving from outside at most this often per collection, however fast they come in. */
export const INGEST_NOTIFY_MS = 2000;

const PAGE_BYTES = 4096;
/** What a table page holds of rows; a row larger than this spills onto pages of its own. */
const PAGE_ROOM = 4000;

/**
 * What a document that came from outside counts against the ingest quota: the database pages it can take at worst, not the
 * bytes of its JSON. A row shares its page with as many others as fit, so a row of just over half a page takes a whole one;
 * the index entries on its path count twice, because index pages can be half empty. The estimate is deliberately on the
 * high side: what is counted for the ingest quota is taken off what the instance's own data is measured by, so counting too
 * little would let data from outside use up the instance's own space.
 */
export function ingestCost(docPath: string, json: string): number {
  const pathBytes = Buffer.byteLength(docPath);
  const row = Buffer.byteLength(json) + 2 * pathBytes + 80;
  const pages = row <= PAGE_ROOM ? PAGE_BYTES / Math.floor(PAGE_ROOM / row) : row + PAGE_BYTES + 512;
  return Math.ceil(pages + 8 * pathBytes + 64);
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A document id made up by the server: 20 letters and digits, each equally likely, about 119 bits. */
export function newDocId(): string {
  let id = '';
  // randomInt and not a random byte modulo 62: 256 is not a multiple of 62, so the first letters would come up more often.
  for (let i = 0; i < 20; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

/**
 * Everyone who ever wrote a shared document here, so their name stays resolvable after the document was edited by
 * someone else or deleted. Private areas are left out: nobody else may learn that an account used the instance privately.
 */
const AUTHORS_SCHEMA = 'CREATE TABLE authors (user_id TEXT PRIMARY KEY) WITHOUT ROWID';
const AUTHORS_BACKFILL = `INSERT OR IGNORE INTO authors (user_id)
  SELECT DISTINCT updated_by FROM docs WHERE updated_by IS NOT NULL AND path NOT LIKE 'data/users/%'`;

const toDoc = (r: DocRow): Doc => ({
  path: r.path, id: r.id, data: JSON.parse(r.data) as Record<string, unknown>, version: r.version,
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
});

/**
 * `undefined` for an ordinary path; for anything under `data/users/` (matched case-insensitively, to stay on the safe side)
 * the id of the user whose area it is, or `null` when it is nobody's (`data/users` itself, other letter case).
 */
function privateAreaOwner(segs: string[]): string | null | undefined {
  if (segs[0].toLowerCase() !== 'data' || segs[1]?.toLowerCase() !== 'users') return undefined;
  // Only the exact spelling is a real private area; other spellings belong to nobody (and are never exported or imported).
  return segs[0] === 'data' && segs[1] === 'users' && segs.length >= 3 ? segs[2] : null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Recursive merge: objects merge key by key, everything else (arrays, scalars, null) replaces. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : v;
  }
  return out;
}

function formatStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

function stampToIso(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp)!;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

export class InstanceData {
  private dbs: HandleCache;
  private lastStamp = 0;
  private extraUsage: (instanceId: string) => number = () => 0;
  /** Per instance and collection: when its listeners last heard of a received document, and the notice that is still to come. */
  private ingestNotices = new Map<string, { last: number; timer: NodeJS.Timeout | null; path: string }>();

  /** `quotaBytes` caps the size of one instance's data (0 = unlimited). */
  constructor(private dataDir: string, private hub: Hub, private snapshotKeep: number, private quotaBytes = 0, maxOpen?: number) {
    this.dbs = new HandleCache(maxOpen);
  }

  /** How many instance databases are open right now. */
  get openHandles(): number {
    return this.dbs.size;
  }

  private instanceDir(instanceId: string): string {
    if (typeof instanceId !== 'string' || !INSTANCE_ID_RE.test(instanceId)) {
      throw new LagerError('invalid_argument', 'Invalid instance id.');
    }
    return path.join(this.dataDir, 'instances', instanceId);
  }

  private dataFile(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'data.sqlite');
  }

  private snapshotDir(instanceId: string): string {
    return path.join(this.instanceDir(instanceId), 'snapshots');
  }

  hasData(instanceId: string): boolean {
    return fs.existsSync(this.dataFile(instanceId));
  }

  /**
   * Bytes of the instance's own data in its database (free pages do not count, so deleting makes room again); 0 without data.
   * Documents that came from outside are left out: they have a quota of their own (see `ingestUsage`).
   */
  usage(instanceId: string): number {
    const db = this.open(instanceId, false);
    if (!db) return 0;
    const n = (pragma: string): number => Number((db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma]);
    return Math.max(0, (n('page_count') - n('freelist_count')) * n('page_size') - this.ingestBytes(db));
  }

  private ingestBytes(db: DatabaseSync): number {
    return Number((db.prepare('SELECT bytes FROM ingest_usage WHERE id = 1').get() as { bytes: number }).bytes);
  }

  /** What the documents that came from outside, and that nobody changed since, count against the ingest quota. */
  ingestUsage(instanceId: string): number {
    const db = this.open(instanceId, false);
    return db ? this.ingestBytes(db) : 0;
  }

  /** Registers bytes stored next to the documents (uploaded assets) that count against the same quota. */
  setExtraUsage(fn: (instanceId: string) => number): void {
    this.extraUsage = fn;
  }

  /** Throws `quota_exceeded` when the instance's storage is already full. */
  assertQuota(instanceId: string): void {
    if (this.quotaBytes > 0 && this.usage(instanceId) + this.extraUsage(instanceId) >= this.quotaBytes) {
      throw new LagerError('quota_exceeded', 'This instance\'s storage is full.');
    }
  }

  /** Closes the instance database and moves its directory (data and snapshots) to `<dataDir>/trash`. */
  trash(instanceId: string): void {
    const dir = this.instanceDir(instanceId);
    this.dbs.close(instanceId);
    if (!fs.existsSync(dir)) return;
    const trash = path.join(this.dataDir, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dir, path.join(trash, `${instanceId}-${formatStamp(Date.now())}`));
  }

  /**
   * Opens (and caches) the instance database; reads pass create=false so they never create files. The cache closes handles
   * that were not used for a while, so use the result right away and never keep it across an `await` or a `yield`.
   */
  private open(instanceId: string, create: boolean): DatabaseSync | null {
    const cached = this.dbs.get(instanceId);
    if (cached) return cached;
    const file = this.dataFile(instanceId);
    if (!create && !fs.existsSync(file)) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    db.exec(INGEST_SCHEMA);
    // A database from before the authors table (also a restored snapshot) gets it once, filled from the documents it holds.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authors'").get()) {
      db.exec(`BEGIN IMMEDIATE; ${AUTHORS_SCHEMA}; ${AUTHORS_BACKFILL}; COMMIT`);
    }
    this.dbs.set(instanceId, db);
    return db;
  }

  private transaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  private row(db: DatabaseSync, docPath: string): DocRow | undefined {
    return db.prepare('SELECT * FROM docs WHERE path = ?').get(docPath) as DocRow | undefined;
  }

  /** Remembers a signed-in writer of a shared document; call inside the write's transaction. */
  private recordAuthor(db: DatabaseSync, docPath: string, by: string | null): void {
    if (by === null || privateAreaOwner(docPath.split('/')) !== undefined) return;
    db.prepare('INSERT OR IGNORE INTO authors (user_id) VALUES (?)').run(by);
  }

  private notify(instanceId: string, docPath: string, parent: string): void {
    this.hub.publish(instanceId, { type: 'change', path: docPath, parent });
  }

  get(instanceId: string, docPath: string): Doc | null {
    parseDocPath(docPath);
    const db = this.open(instanceId, false);
    const r = db ? this.row(db, docPath) : undefined;
    return r ? toDoc(r) : null;
  }

  private write(instanceId: string, docPath: string, data: Record<string, unknown>, by: string | null, merge: boolean): Doc {
    const { parent, id } = parseDocPath(docPath);
    assertDocData(data);
    this.assertQuota(instanceId);
    const db = this.open(instanceId, true)!;
    const doc = this.transaction(db, () => {
      const now = new Date().toISOString();
      const existing = this.row(db, docPath);
      const next = merge && existing ? deepMerge(JSON.parse(existing.data) as Record<string, unknown>, data) : data;
      if (merge) assertDocData(next);
      const json = JSON.stringify(next);
      if (existing) {
        db.prepare('UPDATE docs SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE path = ?')
          .run(json, now, by, docPath);
      } else {
        db.prepare('INSERT INTO docs (path, parent, id, data, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
          .run(docPath, parent, id, json, now, now, by);
      }
      this.recordAuthor(db, docPath, by);
      return toDoc(this.row(db, docPath)!);
    });
    this.notify(instanceId, docPath, parent);
    return doc;
  }

  set(instanceId: string, docPath: string, data: Record<string, unknown>, by: string | null): Doc {
    return this.write(instanceId, docPath, data, by, false);
  }

  update(instanceId: string, docPath: string, data: Record<string, unknown>, by: string | null): Doc {
    return this.write(instanceId, docPath, data, by, true);
  }

  /**
   * Stores a document that comes from outside the circle of people who may write: a request to an ingest endpoint, or a
   * visitor appending under an `anyone` rule. The caller makes up `docPath` with a fresh id, so this only ever adds. Such
   * documents count against `quotaBytes`, the ingest quota of the instance, and never against its own storage. When that is
   * full the write is refused with `quota_exceeded`, unless `rotate` is set: then the oldest received documents of the same
   * collection make room, as long as there are any.
   */
  ingest(instanceId: string, docPath: string, data: Record<string, unknown>, opts: { by: string | null; quotaBytes: number; rotate: boolean }): Doc {
    const { parent, id } = parseDocPath(docPath);
    assertDocData(data);
    const json = JSON.stringify(data);
    const cost = ingestCost(docPath, json);
    const full = (): never => { throw new LagerError('quota_exceeded', 'This instance cannot take more data from outside right now.'); };
    if (cost > opts.quotaBytes) full();
    const db = this.open(instanceId, true)!;
    const dropped: string[] = [];
    // What arrives from outside does not have to survive a power cut that happens within the same moment, and anyone can send
    // it: these commits are not forced to disk one by one, so a flood of requests is not a flood of disk syncs as well.
    db.exec('PRAGMA synchronous = NORMAL');
    let doc: Doc;
    try {
      doc = this.transaction(db, () => {
        while (this.ingestBytes(db) + cost > opts.quotaBytes) {
          const oldest = opts.rotate
            ? db.prepare('SELECT path FROM ingested WHERE parent = ? ORDER BY seq LIMIT ?').all(parent, ROTATE_BATCH) as unknown as Array<{ path: string }> : [];
          if (oldest.length === 0) full();
          for (const o of oldest) {
            if (this.ingestBytes(db) + cost <= opts.quotaBytes) break;
            db.prepare('DELETE FROM docs WHERE path = ?').run(o.path);
            // The trigger has done this already; said again so that an entry without a document can never keep this loop going.
            db.prepare('DELETE FROM ingested WHERE path = ?').run(o.path);
            dropped.push(o.path);
          }
        }
        const now = new Date().toISOString();
        db.prepare('INSERT INTO docs (path, parent, id, data, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
          .run(docPath, parent, id, json, now, now, opts.by);
        db.prepare('INSERT INTO ingested (path, parent, bytes) VALUES (?, ?, ?)').run(docPath, parent, cost);
        this.recordAuthor(db, docPath, opts.by);
        return toDoc(this.row(db, docPath)!);
      });
    } finally {
      // SQLite's default, which every other write keeps.
      db.exec('PRAGMA synchronous = FULL');
    }
    for (const p of dropped) this.notify(instanceId, p, parent);
    this.notifyIngested(instanceId, docPath, parent);
    return doc;
  }

  /** The first received document of a collection is announced at once, further ones together when the interval is over. */
  private notifyIngested(instanceId: string, docPath: string, parent: string): void {
    const key = `${instanceId}\n${parent}`;
    const now = Date.now();
    for (const [k, e] of this.ingestNotices) if (e.timer === null && now - e.last >= INGEST_NOTIFY_MS) this.ingestNotices.delete(k);
    const entry = this.ingestNotices.get(key);
    if (!entry) {
      this.ingestNotices.set(key, { last: now, timer: null, path: docPath });
      this.notify(instanceId, docPath, parent);
      return;
    }
    entry.path = docPath;
    if (entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.last = Date.now();
      this.notify(instanceId, entry.path, parent);
    }, Math.max(0, entry.last + INGEST_NOTIFY_MS - now));
    entry.timer.unref();
  }

  /** Whether `userId` ever wrote a document of the instance outside the private areas. */
  hasAuthor(instanceId: string, userId: string): boolean {
    const db = this.open(instanceId, false);
    return db !== null && db.prepare('SELECT 1 FROM authors WHERE user_id = ?').get(userId) !== undefined;
  }

  delete(instanceId: string, docPath: string): boolean {
    const { parent } = parseDocPath(docPath);
    const db = this.open(instanceId, false);
    if (!db) return false;
    const changes = Number(db.prepare('DELETE FROM docs WHERE path = ?').run(docPath).changes);
    if (changes === 0) return false;
    this.notify(instanceId, docPath, parent);
    return true;
  }

  query(instanceId: string, collectionPath: string, spec: QuerySpec = {}, visible?: (path: string) => boolean): Doc[] {
    assertCollectionPath(collectionPath);
    // validate the spec even when there is nothing to query
    const limit = queryLimit(spec);
    const db = this.open(instanceId, false);
    if (!db) return [];
    // Without a filter or an order of its own the result is the first documents by id, which SQLite can pick itself
    // (ids are ASCII, so its order is the one runQuery uses); everything else is evaluated in JavaScript.
    const plain = !spec.where?.length && !spec.orderBy?.length;
    let rows = (plain
      ? (visible
        ? db.prepare('SELECT * FROM docs WHERE parent = ? ORDER BY id').all(collectionPath)
        : db.prepare('SELECT * FROM docs WHERE parent = ? ORDER BY id LIMIT ?').all(collectionPath, limit))
      : db.prepare('SELECT * FROM docs WHERE parent = ?').all(collectionPath)) as unknown as DocRow[];
    // Documents the caller may not see are dropped before parsing, filtering, sorting and limiting, so they cannot shape the result.
    if (visible) rows = rows.filter((r) => visible(r.path));
    if (plain) rows = rows.slice(0, limit);
    return runQuery(rows.map(toDoc), spec);
  }

  acquire(
    instanceId: string, docPath: string,
    opts: { holder: string; ttlMs?: number; data?: Record<string, unknown> }, by: string | null,
  ): AcquireResult {
    const { parent, id } = parseDocPath(docPath);
    if (typeof opts.holder !== 'string' || opts.holder === '' || Buffer.byteLength(opts.holder) > 200) {
      throw new LagerError('invalid_argument', 'holder must be a non-empty string of at most 200 bytes.');
    }
    if (opts.data !== undefined) assertDocData(opts.data);
    const ttl = Math.min(Math.max(Number.isFinite(opts.ttlMs) ? Math.floor(opts.ttlMs!) : DEFAULT_TTL_MS, 1), MAX_TTL_MS);
    const db = this.open(instanceId, true)!;
    // Renewing a lease on an existing document adds nothing; everything else (new data, a new document) counts against the quota.
    if (opts.data !== undefined || !this.row(db, docPath)) this.assertQuota(instanceId);
    const result = this.transaction(db, (): AcquireResult => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const existing = this.row(db, docPath);
      if (
        existing?.lease_holder && existing.lease_holder !== opts.holder &&
        existing.lease_expires && Date.parse(existing.lease_expires) > nowMs
      ) {
        // The holder string is the only credential of a lease, so a refused caller never learns it.
        return { acquired: false, expiresAt: existing.lease_expires, version: existing.version };
      }
      const expires = new Date(nowMs + ttl).toISOString();
      if (existing) {
        const next = opts.data ? deepMerge(JSON.parse(existing.data) as Record<string, unknown>, opts.data) : undefined;
        if (next) assertDocData(next);
        db.prepare(
          'UPDATE docs SET data = ?, version = version + 1, updated_at = ?, updated_by = ?, lease_holder = ?, lease_expires = ? WHERE path = ?',
        ).run(next ? JSON.stringify(next) : existing.data, now, by, opts.holder, expires, docPath);
      } else {
        db.prepare(
          'INSERT INTO docs (path, parent, id, data, version, created_at, updated_at, updated_by, lease_holder, lease_expires) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
        ).run(docPath, parent, id, JSON.stringify(opts.data ?? {}), now, now, by, opts.holder, expires);
      }
      this.recordAuthor(db, docPath, by);
      return { acquired: true, expiresAt: expires, version: this.row(db, docPath)!.version };
    });
    if (result.acquired) this.notify(instanceId, docPath, parent);
    return result;
  }

  /**
   * Deletes the private area of `userId` in the instance (`data/users/<id>/…`), which nobody else can read or remove; for an
   * account that no longer exists. At most `limit` documents per call, so one instance never holds the server for long;
   * returns how many went, and the caller comes back while that is `limit`. Nobody is listening on these paths any more, so no change is announced.
   */
  purgePrivateArea(instanceId: string, userId: string, limit = PRIVATE_PURGE_LIMIT): number {
    const db = this.open(instanceId, false);
    if (!db) return 0;
    // Everything between "<prefix>/" and "<prefix>0" ("0" follows "/"): a range on the primary key, no scan.
    const prefix = `data/users/${userId}`;
    return Number(db.prepare('DELETE FROM docs WHERE path IN (SELECT path FROM docs WHERE path >= ? AND path < ? LIMIT ?)').run(`${prefix}/`, `${prefix}0`, limit).changes);
  }

  // ---- export and import ----------------------------------------------

  /**
   * All documents ordered by path, read in keyset-paged batches so an export never holds the instance in memory.
   * Everything under `data/users/` is left out except the area of `includePrivateOf`.
   */
  *exportDocs(instanceId: string, opts: { includePrivateOf?: string; filter?: (path: string) => boolean } = {}): Generator<{ path: string; data: Record<string, unknown> }> {
    let after = '';
    for (;;) {
      // Fetched anew for every batch: the consumer may be a slow download, and an idle handle can be closed in between.
      const db = this.open(instanceId, false);
      if (!db) {
        // Nothing to export is fine at the start; data that vanishes half-way (the instance was deleted) must not look like a complete export.
        if (after === '') return;
        throw new LagerError('not_found', 'The instance was deleted during the export.');
      }
      const rows = db.prepare('SELECT path, data FROM docs WHERE path > ? ORDER BY path LIMIT ?').all(after, EXPORT_BATCH) as unknown as Array<{ path: string; data: string }>;
      for (const r of rows) {
        const owner = privateAreaOwner(r.path.split('/'));
        // The filter runs before the JSON is parsed, so skipped documents cost no parsing.
        if ((owner === undefined || (opts.includePrivateOf !== undefined && owner === opts.includePrivateOf)) && (opts.filter?.(r.path) ?? true)) {
          yield { path: r.path, data: JSON.parse(r.data) as Record<string, unknown> };
        }
      }
      if (rows.length < EXPORT_BATCH) return;
      after = rows[rows.length - 1].path;
    }
  }

  /**
   * Replaces (set semantics) the given documents. Every document is validated first; then all are written in one
   * transaction, so a failure leaves the instance untouched. A path under `data/users/` is only accepted for the
   * user `allowPrivateOf`. The quota applies to the result.
   */
  importDocs(
    instanceId: string, docs: Iterable<{ path: string; data: Record<string, unknown> }>, by: string | null,
    opts: { allowPrivateOf?: string } = {},
  ): { imported: number } {
    const checked = new Map<string, { parent: string; id: string; json: string }>();
    let sharedPath: string | undefined;
    for (const d of docs) {
      if (typeof d?.path !== 'string') throw new LagerError('invalid_argument', 'Path must be a non-empty string.');
      // The private-area check comes first so a malformed path under data/users/ is refused as such.
      const owner = privateAreaOwner(d.path.split('/'));
      if (owner !== undefined && (owner === null || owner !== opts.allowPrivateOf)) {
        throw new LagerError('forbidden', `The private area "${d.path}" belongs to another user and cannot be written.`);
      }
      const { parent, id } = parseDocPath(d.path);
      assertDocData(d.data);
      checked.set(d.path, { parent, id, json: JSON.stringify(d.data) });
      if (owner === undefined) sharedPath = d.path;
    }
    if (checked.size === 0) return { imported: 0 };
    this.assertQuota(instanceId);
    const db = this.open(instanceId, true)!;
    this.transaction(db, () => {
      const now = new Date().toISOString();
      const upsert = db.prepare(
        `INSERT INTO docs (path, parent, id, data, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      );
      for (const [p, d] of checked) upsert.run(p, d.parent, d.id, d.json, now, now, by);
      // The author is the same for every document: one entry is enough, and only if something landed outside the private areas.
      if (sharedPath !== undefined) this.recordAuthor(db, sharedPath, by);
      if (this.quotaBytes > 0 && this.usage(instanceId) + this.extraUsage(instanceId) > this.quotaBytes) {
        throw new LagerError('quota_exceeded', 'This instance\'s storage is full.');
      }
    });
    this.hub.publish(instanceId, { type: 'reset' });
    return { imported: checked.size };
  }

  // ---- snapshots -------------------------------------------------------

  private nextStamp(dir: string): string {
    let ms = Math.max(Date.now(), this.lastStamp + 1);
    // guard against ids already on disk (another process, clock going backwards)
    while (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(formatStamp(ms)))) ms++;
    this.lastStamp = ms;
    return formatStamp(ms);
  }

  snapshot(instanceId: string, label: string): SnapshotInfo | null {
    if (typeof label !== 'string' || !LABEL_RE.test(label)) {
      throw new LagerError('invalid_argument', 'Snapshot label may only contain a-z, 0-9 and "-" (max 64 characters).');
    }
    if (!this.hasData(instanceId)) return null;
    const db = this.open(instanceId, false)!;
    const dir = this.snapshotDir(instanceId);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${this.nextStamp(dir)}-${label}`;
    const final = path.join(dir, `${id}.sqlite`);
    const tmp = `${final}.tmp`;
    fs.rmSync(tmp, { force: true });
    db.prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, final);
    this.prune(instanceId);
    return { id, label, createdAt: stampToIso(id.slice(0, 19)), sizeBytes: fs.statSync(final).size };
  }

  listSnapshots(instanceId: string): SnapshotInfo[] {
    const dir = this.snapshotDir(instanceId);
    if (!fs.existsSync(dir)) return [];
    const out: SnapshotInfo[] = [];
    for (const f of fs.readdirSync(dir)) {
      const m = SNAPSHOT_FILE_RE.exec(f);
      if (!m) continue;
      out.push({
        id: f.slice(0, -'.sqlite'.length), label: m[2], createdAt: stampToIso(m[1]),
        sizeBytes: fs.statSync(path.join(dir, f)).size,
      });
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  /**
   * Drops the oldest snapshots beyond `snapshotKeep` and beyond the byte budget. Two always stay and count first: the newest
   * one, and the newest one that is at least a day old, so that several version changes in a row leave a state from before them.
   */
  private prune(instanceId: string): void {
    const keep = Math.max(1, Math.floor(this.snapshotKeep));
    const budget = this.quotaBytes > 0 ? this.quotaBytes * SNAPSHOT_QUOTA_FACTOR : Infinity;
    const [newest, ...rest] = this.listSnapshots(instanceId);
    if (!newest) return;
    const old = rest.find((s) => Date.parse(s.createdAt) <= Date.now() - SNAPSHOT_OLD_MS);
    let count = old ? 2 : 1;
    let bytes = newest.sizeBytes + (old?.sizeBytes ?? 0);
    let room = true;
    for (const s of rest) {
      if (s === old) continue;
      room = room && count < keep && bytes + s.sizeBytes <= budget;
      if (room) { count++; bytes += s.sizeBytes; } else fs.rmSync(path.join(this.snapshotDir(instanceId), `${s.id}.sqlite`), { force: true });
    }
  }

  restore(instanceId: string, snapshotId: string): void {
    if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(snapshotId)) {
      throw new LagerError('invalid_argument', 'Invalid snapshot id.');
    }
    const source = path.join(this.snapshotDir(instanceId), `${snapshotId}.sqlite`);
    if (!fs.existsSync(source)) throw new LagerError('not_found', 'Snapshot not found.');
    const file = this.dataFile(instanceId);
    // Copy first: taking the pre-restore snapshot may prune the one being restored.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const staged = `${file}.restore.tmp`;
    fs.copyFileSync(source, staged);
    try {
      this.snapshot(instanceId, 'pre-restore');
      this.dbs.close(instanceId);
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
      fs.renameSync(staged, file);
    } finally {
      fs.rmSync(staged, { force: true });
    }
    this.hub.publish(instanceId, { type: 'reset' });
  }

  close(): void {
    for (const e of this.ingestNotices.values()) if (e.timer !== null) clearTimeout(e.timer);
    this.ingestNotices.clear();
    this.dbs.closeAll();
  }
}
