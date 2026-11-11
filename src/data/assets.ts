import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';

export interface AssetInfo { id: string; contentType: string; sizeBytes: number; createdAt: string; uploadedBy: string | null }

const MIB = 1024 * 1024;
export const ASSET_LIMITS = { maxBytes: 20 * MIB, maxScriptBytes: 16 * MIB, maxSvgBytes: 2 * MIB, maxFiles: 2000 };

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_ID_RE = /^[0-9a-f]{32}$/;

const ALLOWED = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4',
  'application/pdf',
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf',
  'text/css', 'text/javascript', 'text/csv', 'text/markdown', 'application/json', 'text/plain',
]);

/** Why an upload was refused; the HTTP layer maps it to the contract's error codes. */
export type AssetReason = 'unsupported_type' | 'too_large' | 'invalid_request';

export class AssetError extends LagerError {
  constructor(public reason: AssetReason, message: string) {
    super('invalid_argument', message);
    this.name = 'AssetError';
  }
}

const ascii = (b: Buffer, from: number, text: string): boolean => b.length >= from + text.length && b.toString('latin1', from, from + text.length) === text;

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  'image/avif': (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')),
  'video/mp4': (b) => ascii(b, 4, 'ftyp'),
  'audio/mp4': (b) => ascii(b, 4, 'ftyp'),
  'video/webm': (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  'audio/mpeg': (b) => ascii(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/ogg': (b) => ascii(b, 0, 'OggS'),
  'audio/wav': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  'application/pdf': (b) => ascii(b, 0, '%PDF'),
  'font/woff': (b) => ascii(b, 0, 'wOFF'),
  'font/woff2': (b) => ascii(b, 0, 'wOF2'),
  'font/ttf': (b) => (b.length >= 4 && b.readUInt32BE(0) === 0x00010000) || ascii(b, 0, 'true'),
  'font/otf': (b) => ascii(b, 0, 'OTTO'),
};

/** The first non-blank character of UTF-8 text, ignoring a byte-order mark. */
function firstChar(b: Buffer): string {
  const start = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  const head = b.toString('utf8', start, Math.min(b.length, start + 512)).trimStart();
  return head.charAt(0);
}

function isUtf8(b: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Per-file size cap for a content type. */
export function maxBytesFor(type: string): number {
  if (type === 'image/svg+xml') return ASSET_LIMITS.maxSvgBytes;
  if (type === 'text/css' || type === 'text/javascript') return ASSET_LIMITS.maxScriptBytes;
  return ASSET_LIMITS.maxBytes;
}

/** Whether responses of this type get a charset and the sandbox policy. */
export function isTextType(type: string): boolean {
  return type.startsWith('text/') || type === 'application/json';
}

/**
 * Returns the allowed content type for an upload or throws an `AssetError`.
 * Nothing is ever served as HTML: markup is accepted only as `image/svg+xml`.
 */
export function normalizeAssetType(declared: string | undefined, bytes: Buffer): string {
  const essence = (declared ?? '').split(';')[0].trim().toLowerCase();
  const type = essence === 'application/javascript' ? 'text/javascript' : essence;
  if (!ALLOWED.has(type)) throw new AssetError('unsupported_type', 'This file type is not supported.');
  if (bytes.length > maxBytesFor(type)) throw new AssetError('too_large', 'The file is too large.');
  const signature = SIGNATURES[type];
  if (signature) {
    if (!signature(bytes)) throw new AssetError('unsupported_type', 'The content does not match the stated file type.');
  } else if (type === 'image/svg+xml') {
    if (!isUtf8(bytes) || firstChar(bytes) !== '<' || !/<svg[\s>/]/i.test(bytes.toString('utf8'))) {
      throw new AssetError('unsupported_type', 'Der Inhalt ist kein SVG-Dokument.');
    }
  } else {
    if (!isUtf8(bytes)) throw new AssetError('invalid_request', 'Text files must be UTF-8.');
    if ((type === 'text/css' || type === 'text/javascript') && firstChar(bytes) === '<') {
      throw new AssetError('unsupported_type', 'Stylesheets and scripts must not start with markup.');
    }
  }
  return type;
}

interface AssetRow { id: string; content_type: string; size_bytes: number; uploaded_by: string | null; created_at: string }

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_by TEXT,
    created_at TEXT NOT NULL
  );
`;

const toInfo = (r: AssetRow): AssetInfo => ({
  id: r.id, contentType: r.content_type, sizeBytes: r.size_bytes, createdAt: r.created_at, uploadedBy: r.uploaded_by,
});

export class InstanceAssets {
  private dbs = new Map<string, DatabaseSync>();

  /** `quotaBytes` caps documents plus assets of one instance (0 = unlimited); `dbUsage` reports the document bytes. */
  constructor(private dataDir: string, private quotaBytes: number, private dbUsage: (instanceId: string) => number) {}

  private instanceDir(instanceId: string): string {
    if (typeof instanceId !== 'string' || !INSTANCE_ID_RE.test(instanceId)) throw new LagerError('invalid_argument', 'Invalid instance id.');
    return path.join(this.dataDir, 'instances', instanceId);
  }

  private open(instanceId: string, create: boolean): DatabaseSync | null {
    const cached = this.dbs.get(instanceId);
    if (cached) return cached;
    const dir = this.instanceDir(instanceId);
    const file = path.join(dir, 'assets.sqlite');
    if (!create && !fs.existsSync(file)) return null;
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    this.dbs.set(instanceId, db);
    return db;
  }

  private filePath(instanceId: string, id: string): string {
    return path.join(this.instanceDir(instanceId), 'assets', id);
  }

  usage(instanceId: string): { files: number; bytes: number } {
    const db = this.open(instanceId, false);
    if (!db) return { files: 0, bytes: 0 };
    const r = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM assets').get() as { files: number; bytes: number };
    return { files: Number(r.files), bytes: Number(r.bytes) };
  }

  /** The most the instance may still hold in assets, counted from zero: stored bytes plus the room left after documents. */
  maxBytes(instanceId: string): number {
    if (this.quotaBytes <= 0) return 2 ** 40;
    return Math.max(this.usage(instanceId).bytes, this.quotaBytes - this.dbUsage(instanceId));
  }

  put(instanceId: string, bytes: Buffer, declaredType: string | undefined, by: string | null): AssetInfo {
    if (bytes.length === 0) throw new AssetError('invalid_request', 'The file is empty.');
    const contentType = normalizeAssetType(declaredType, bytes);
    const used = this.usage(instanceId);
    if (used.files >= ASSET_LIMITS.maxFiles) throw new LagerError('conflict', 'This instance has reached the maximum number of files.');
    if (this.quotaBytes > 0 && this.dbUsage(instanceId) + used.bytes + bytes.length > this.quotaBytes) {
      throw new LagerError('quota_exceeded', 'This instance\'s storage is full.');
    }
    const db = this.open(instanceId, true)!;
    const id = crypto.randomBytes(16).toString('hex');
    const file = this.filePath(instanceId, id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    const createdAt = new Date().toISOString();
    try {
      db.prepare('INSERT INTO assets (id, content_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, contentType, bytes.length, by, createdAt);
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    return { id, contentType, sizeBytes: bytes.length, createdAt, uploadedBy: by };
  }

  get(instanceId: string, id: string): { info: AssetInfo; path: string } | null {
    if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) return null;
    const db = this.open(instanceId, false);
    const row = db?.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
    return row ? { info: toInfo(row), path: this.filePath(instanceId, id) } : null;
  }

  /** Newest first; `onlyBy` restricts the list to one uploader. */
  list(instanceId: string, onlyBy?: string): AssetInfo[] {
    const db = this.open(instanceId, false);
    if (!db) return [];
    const rows = (onlyBy === undefined
      ? db.prepare('SELECT * FROM assets ORDER BY created_at DESC, rowid DESC').all()
      : db.prepare('SELECT * FROM assets WHERE uploaded_by = ? ORDER BY created_at DESC, rowid DESC').all(onlyBy)) as unknown as AssetRow[];
    return rows.map(toInfo);
  }

  delete(instanceId: string, id: string): boolean {
    if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) return false;
    const db = this.open(instanceId, false);
    if (!db) return false;
    const changes = Number(db.prepare('DELETE FROM assets WHERE id = ?').run(id).changes);
    if (changes > 0) fs.rmSync(this.filePath(instanceId, id), { force: true });
    return changes > 0;
  }

  /** Releases the cached handle of one instance (before its directory is moved away). */
  drop(instanceId: string): void {
    this.dbs.get(instanceId)?.close();
    this.dbs.delete(instanceId);
  }

  close(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}
