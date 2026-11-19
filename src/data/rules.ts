import type { DbRule } from '../platform/apps.js';

export type Level = 'none' | 'view' | 'interact' | 'admin' | 'owner';
export interface Viewer { userId: string | null; level: Level }

const RANK: Record<string, number> = { none: 0, view: 1, interact: 2, admin: 3, owner: 4 };
const DEFAULT_READ = 'view';
const DEFAULT_WRITE = 'interact';

/**
 * `data/users/<id>/...` belongs to that user alone; rules cannot loosen this. Reading it takes any level, writing takes
 * `interact` like every other write: a viewer must not be able to fill the instance's storage with data nobody else can see or delete.
 */
function privateAreaAllows(viewer: Viewer, segs: string[], kind: 'read' | 'write'): boolean | null {
  if (segs[0] !== 'data' || segs[1] !== 'users') return null;
  if (segs.length < 3 || viewer.userId === null || viewer.userId !== segs[2]) return false;
  return RANK[viewer.level] >= RANK[kind === 'read' ? DEFAULT_READ : DEFAULT_WRITE];
}

function ruleMatches(rule: DbRule, segs: string[], viewer: Viewer): number {
  const rs = rule.path.split('/').filter((s) => s !== '');
  if (rs.length === 0 || rs.length > segs.length) return -1;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i] === '{self}') {
      if (viewer.userId === null || segs[i] !== viewer.userId) return -1;
    } else if (rs[i] !== segs[i]) return -1;
  }
  return rs.length;
}

function check(rules: DbRule[] | undefined, viewer: Viewer, path: string, kind: 'read' | 'write'): boolean {
  const segs = path.split('/');
  const priv = privateAreaAllows(viewer, segs, kind);
  if (priv !== null) return priv;
  if (kind === 'write' && viewer.userId === null) return false;

  // The most specific matching rule that sets this kind decides; a rule that only sets `write` leaves `read` to the broader rule.
  let required: string = kind === 'read' ? DEFAULT_READ : DEFAULT_WRITE;
  let bestLen = 0;
  for (const rule of rules ?? []) {
    const level = rule[kind];
    if (level === undefined) continue;
    const len = ruleMatches(rule, segs, viewer);
    if (len > bestLen) { required = level; bestLen = len; }
  }
  // "self" and "none" are held by nobody; unknown levels fail closed.
  if (required === 'self' || required === 'none' || !(required in RANK)) return false;
  return RANK[viewer.level] >= RANK[required];
}

export function canRead(rules: DbRule[] | undefined, viewer: Viewer, path: string): boolean {
  return check(rules, viewer, path, 'read');
}

export function canWrite(rules: DbRule[] | undefined, viewer: Viewer, path: string): boolean {
  return check(rules, viewer, path, 'write');
}
