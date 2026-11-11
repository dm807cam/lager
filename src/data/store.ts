import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';
import type { Hub } from './hub.js';
import { assertCollectionPath, assertDocData, parseDocPath } from './paths.js';
import { runQuery, type QuerySpec } from './query.js';

export interface Doc {
  path: string; id: string; data: Record<string, unknown>; version: number;
  createdAt: string; updatedAt: string; updatedBy: string | null;
}
export interface SnapshotInfo { id: string; label: string; createdAt: string; sizeBytes: number }
export interface AcquireResult { acquired: boolean; version?: number; expiresAt?: string; holder?: string }

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
  private dbs = new Map<string, DatabaseSync>();
  private lastStamp = 0;
  private extraUsage: (instanceId: string) => number = () => 0;

  /** `quotaBytes` caps the size of one instance's data (0 = unlimited). */
  constructor(private dataDir: string, private hub: Hub, private snapshotKeep: number, private quotaBytes = 0) {}

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

  /** Bytes of live data in the instance database (free pages do not count, so deleting makes room again); 0 without data. */
  usage(instanceId: string): number {
    const db = this.open(instanceId, false);
    if (!db) return 0;
    const n = (pragma: string): number => Number((db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma]);
    return (n('page_count') - n('freelist_count')) * n('page_size');
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
    this.dbs.get(instanceId)?.close();
    this.dbs.delete(instanceId);
    if (!fs.existsSync(dir)) return;
    const trash = path.join(this.dataDir, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dir, path.join(trash, `${instanceId}-${formatStamp(Date.now())}`));
  }

  /** Opens (and caches) the instance database; reads pass create=false so they never create files. */
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

  delete(instanceId: string, docPath: string): boolean {
    const { parent } = parseDocPath(docPath);
    const db = this.open(instanceId, false);
    if (!db) return false;
    const changes = Number(db.prepare('DELETE FROM docs WHERE path = ?').run(docPath).changes);
    if (changes === 0) return false;
    this.notify(instanceId, docPath, parent);
    return true;
  }

  query(instanceId: string, collectionPath: string, spec: QuerySpec = {}): Doc[] {
    assertCollectionPath(collectionPath);
    const db = this.open(instanceId, false);
    // validate the spec even when there is nothing to query
    if (!db) { runQuery([], spec); return []; }
    const rows = db.prepare('SELECT * FROM docs WHERE parent = ?').all(collectionPath) as unknown as DocRow[];
    const docs = rows.map(toDoc);
    return runQuery(docs, spec);
  }

  acquire(
    instanceId: string, docPath: string,
    opts: { holder: string; ttlMs?: number; data?: Record<string, unknown> }, by: string | null,
  ): AcquireResult {
    const { parent, id } = parseDocPath(docPath);
    if (typeof opts.holder !== 'string' || opts.holder === '' || Buffer.byteLength(opts.holder) > 200) {
      throw new LagerError('invalid_argument', 'holder must be a non-empty string of at most 200 bytes.');
    }
    if (opts.data !== undefined) {
      assertDocData(opts.data);
      this.assertQuota(instanceId);
    }
    const ttl = Math.min(Math.max(Number.isFinite(opts.ttlMs) ? Math.floor(opts.ttlMs!) : DEFAULT_TTL_MS, 1), MAX_TTL_MS);
    const db = this.open(instanceId, true)!;
    const result = this.transaction(db, (): AcquireResult => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const existing = this.row(db, docPath);
      if (
        existing?.lease_holder && existing.lease_holder !== opts.holder &&
        existing.lease_expires && Date.parse(existing.lease_expires) > nowMs
      ) {
        return { acquired: false, holder: existing.lease_holder, expiresAt: existing.lease_expires, version: existing.version };
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
      return { acquired: true, holder: opts.holder, expiresAt: expires, version: this.row(db, docPath)!.version };
    });
    if (result.acquired) this.notify(instanceId, docPath, parent);
    return result;
  }

  // ---- export and import ----------------------------------------------

  /**
   * All documents ordered by path, read in keyset-paged batches so an export never holds the instance in memory.
   * Everything under `data/users/` is left out except the area of `includePrivateOf`.
   */
  *exportDocs(instanceId: string, opts: { includePrivateOf?: string; filter?: (path: string) => boolean } = {}): Generator<{ path: string; data: Record<string, unknown> }> {
    const db = this.open(instanceId, false);
    if (!db) return;
    let after = '';
    for (;;) {
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

  private prune(instanceId: string): void {
    const keep = Math.max(1, Math.floor(this.snapshotKeep));
    for (const s of this.listSnapshots(instanceId).slice(keep)) {
      fs.rmSync(path.join(this.snapshotDir(instanceId), `${s.id}.sqlite`), { force: true });
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
      this.dbs.get(instanceId)?.close();
      this.dbs.delete(instanceId);
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
      fs.renameSync(staged, file);
    } finally {
      fs.rmSync(staged, { force: true });
    }
    this.hub.publish(instanceId, { type: 'reset' });
  }

  close(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}
