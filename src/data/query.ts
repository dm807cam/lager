import { LagerError } from '../errors.js';

export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains' | 'array-contains-any';
export interface QuerySpec { where?: [string, WhereOp, unknown][]; orderBy?: [string, 'asc' | 'desc'][]; limit?: number }
export interface Row { id: string; data: Record<string, unknown> }

const OPS: WhereOp[] = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'];
const MAX_LIMIT = 1000;

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function getField(data: Record<string, unknown>, field: string): unknown {
  let cur: unknown = data;
  for (const part of field.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  const t = jsonType(a);
  if (t !== jsonType(b)) return false;
  if (t === 'array') {
    const x = a as unknown[], y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  if (t === 'object') {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    const kx = Object.keys(x);
    return kx.length === Object.keys(y).length && kx.every((k) => Object.hasOwn(y, k) && deepEqual(x[k], y[k]));
  }
  return a === b;
}

/** Ordering comparison; only numbers with numbers and strings with strings are comparable. */
function compareSame(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/** A missing field or a type mismatch never matches (including for "!="). */
function matches(field: unknown, op: WhereOp, value: unknown): boolean {
  if (field === undefined) return false;
  switch (op) {
    case '==': return deepEqual(field, value);
    case '!=': return jsonType(field) === jsonType(value) && !deepEqual(field, value);
    case '<': { const c = compareSame(field, value); return c !== null && c < 0; }
    case '<=': { const c = compareSame(field, value); return c !== null && c <= 0; }
    case '>': { const c = compareSame(field, value); return c !== null && c > 0; }
    case '>=': { const c = compareSame(field, value); return c !== null && c >= 0; }
    case 'in': return (value as unknown[]).some((v) => deepEqual(field, v));
    case 'not-in': return !(value as unknown[]).some((v) => deepEqual(field, v));
    case 'array-contains': return Array.isArray(field) && field.some((v) => deepEqual(v, value));
    case 'array-contains-any': return Array.isArray(field) && field.some((v) => (value as unknown[]).some((w) => deepEqual(v, w)));
  }
}

const TYPE_RANK: Record<string, number> = { null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 };

function compareForSort(a: unknown, b: unknown): number {
  const ta = jsonType(a), tb = jsonType(b);
  if (ta !== tb) return TYPE_RANK[ta] - TYPE_RANK[tb];
  const c = compareSame(a, b);
  if (c !== null) return c;
  if (ta === 'boolean') return Number(a) - Number(b);
  return 0;
}

function validate(spec: QuerySpec): number {
  const bad = (m: string) => new LagerError('invalid_argument', m);
  if (spec.where !== undefined && !Array.isArray(spec.where)) throw bad('where must be a list of [field, op, value] clauses.');
  if (spec.orderBy !== undefined && !Array.isArray(spec.orderBy)) throw bad('orderBy must be a list of [field, "asc"|"desc"] entries.');
  for (const w of spec.where ?? []) {
    if (!Array.isArray(w) || w.length !== 3 || typeof w[0] !== 'string' || w[0] === '') throw bad('Each where clause must be [field, op, value].');
    if (!OPS.includes(w[1])) throw bad(`Unknown where operator "${String(w[1])}".`);
    if ((w[1] === 'in' || w[1] === 'not-in' || w[1] === 'array-contains-any') && !Array.isArray(w[2])) {
      throw bad(`Operator "${w[1]}" needs an array value.`);
    }
  }
  for (const o of spec.orderBy ?? []) {
    if (!Array.isArray(o) || typeof o[0] !== 'string' || o[0] === '' || (o[1] !== 'asc' && o[1] !== 'desc')) {
      throw bad('Each orderBy entry must be [field, "asc"|"desc"].');
    }
  }
  const limit = spec.limit ?? MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  return limit;
}

/** Filters, sorts and limits rows. Default order is by id ascending, which is also the tie-breaker. */
export function runQuery<T extends Row>(rows: T[], spec: QuerySpec = {}): T[] {
  const limit = validate(spec);
  let out = rows.filter((r) => (spec.where ?? []).every(([f, op, v]) => matches(getField(r.data, f), op, v)));
  const order = spec.orderBy ?? [];
  out = out.sort((a, b) => {
    for (const [f, dir] of order) {
      const va = getField(a.data, f), vb = getField(b.data, f);
      if (va === undefined || vb === undefined) {
        if (va === vb) continue;
        return va === undefined ? 1 : -1; // missing fields sort last in either direction
      }
      const c = compareForSort(va, vb);
      if (c !== 0) return dir === 'asc' ? c : -c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out.slice(0, limit);
}
