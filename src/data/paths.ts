import { LagerError } from '../errors.js';

const MAX_SEGMENTS = 16;
const MAX_SEGMENT_BYTES = 200;
const MAX_PATH_BYTES = 1000;
const MAX_DOC_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
/** The characters a path segment may use; the browser runtime enforces the same set, so every stored path stays addressable. */
const SEGMENT_RE = /^[A-Za-z0-9_\-.~:@+]+$/;

function segments(path: unknown): string[] {
  if (typeof path !== 'string' || path === '') throw new LagerError('invalid_argument', 'Path must be a non-empty string.');
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw new LagerError('invalid_argument', `Path is limited to ${MAX_PATH_BYTES} bytes.`);
  const segs = path.split('/');
  if (segs.length > MAX_SEGMENTS) throw new LagerError('invalid_argument', `Path has more than ${MAX_SEGMENTS} segments.`);
  for (const s of segs) {
    if (s === '') throw new LagerError('invalid_argument', 'Path must not contain empty segments.');
    if (s === '.' || s === '..') throw new LagerError('invalid_argument', 'Path segments must not be "." or "..".');
    if (!SEGMENT_RE.test(s)) throw new LagerError('invalid_argument', `Path segment "${s}" uses characters other than letters, digits and _ - . ~ : @ +.`);
    if (Buffer.byteLength(s) > MAX_SEGMENT_BYTES) {
      throw new LagerError('invalid_argument', `Path segments are limited to ${MAX_SEGMENT_BYTES} bytes.`);
    }
  }
  return segs;
}

/** A document path has an even number of segments: collection/doc[/collection/doc...]. */
export function parseDocPath(path: string): { parent: string; id: string } {
  const segs = segments(path);
  if (segs.length % 2 !== 0) throw new LagerError('invalid_argument', `"${path}" is a collection path, a document path is required.`);
  return { parent: segs.slice(0, -1).join('/'), id: segs[segs.length - 1] };
}

/** A collection path has an odd number of segments. */
export function assertCollectionPath(path: string): void {
  const segs = segments(path);
  if (segs.length % 2 !== 1) throw new LagerError('invalid_argument', `"${path}" is a document path, a collection path is required.`);
}

function checkValue(v: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new LagerError('invalid_argument', `Document is nested deeper than ${MAX_DEPTH} levels.`);
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new LagerError('invalid_argument', 'Numbers must be finite.');
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) checkValue(item, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      if (k === '__proto__') throw new LagerError('invalid_argument', 'Field name "__proto__" is not allowed.');
      checkValue(item, depth + 1);
    }
    return;
  }
  throw new LagerError('invalid_argument', 'Document contains a value that is not JSON.');
}

export function assertDocData(data: unknown): asserts data is Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LagerError('invalid_argument', 'Document data must be a JSON object.');
  }
  checkValue(data, 1);
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES) {
    throw new LagerError('invalid_argument', 'Document exceeds the limit of 256 KiB.');
  }
}
