import type { DbRule } from '../platform/apps.js';

export type Level = 'none' | 'view' | 'interact' | 'admin' | 'owner';
export interface Viewer { userId: string | null; level: Level }

const RANK: Record<string, number> = { none: 0, view: 1, interact: 2, admin: 3, owner: 4 };
const DEFAULT_READ = 'view';
const DEFAULT_WRITE = 'interact';
/** As a `write` level: every visitor who can open the instance may append (see `appendRule`); changing and deleting stay at the default. */
const ANYONE = 'anyone';
/** `delete` is a write everywhere except in one's own private area. */
type Kind = 'read' | 'write' | 'delete';

/**
 * `data/users/<id>/...` belongs to that user alone; rules cannot loosen this. Reading it takes any level, writing takes
 * `interact` like every other write: a viewer must not be able to fill the instance's storage with data nobody else can see or delete.
 * Deleting takes any level too: nobody else can remove this data, so someone lowered to `view` must still be able to.
 */
function privateAreaAllows(viewer: Viewer, segs: string[], kind: Kind): boolean | null {
  if (segs[0] !== 'data' || segs[1] !== 'users') return null;
  if (segs.length < 3 || viewer.userId === null || viewer.userId !== segs[2]) return false;
  return RANK[viewer.level] >= RANK[kind === 'write' ? DEFAULT_WRITE : DEFAULT_READ];
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

/** The most specific matching rule that sets this kind decides; a rule that only sets `write` leaves `read` to the broader rule. */
function deciding(rules: DbRule[] | undefined, viewer: Viewer, segs: string[], kind: 'read' | 'write'): { level: string; path: string | null } {
  let found: { level: string; path: string | null } = { level: kind === 'read' ? DEFAULT_READ : DEFAULT_WRITE, path: null };
  let bestLen = 0;
  for (const rule of rules ?? []) {
    const level = rule[kind];
    if (level === undefined) continue;
    const len = ruleMatches(rule, segs, viewer);
    if (len > bestLen) { found = { level, path: rule.path }; bestLen = len; }
  }
  return found;
}

function check(rules: DbRule[] | undefined, viewer: Viewer, path: string, asked: Kind): boolean {
  const segs = path.split('/');
  const priv = privateAreaAllows(viewer, segs, asked);
  if (priv !== null) return priv;
  const kind = asked === 'read' ? 'read' : 'write';
  if (kind === 'write' && viewer.userId === null) return false;

  let required = deciding(rules, viewer, segs, kind).level;
  // `anyone` opens appending only; who may change and delete on such a path is who may without the rule.
  if (kind === 'write' && required === ANYONE) required = DEFAULT_WRITE;
  // "self" and "none" are held by nobody; unknown levels fail closed.
  if (required === 'self' || required === 'none' || !(required in RANK)) return false;
  return RANK[viewer.level] >= RANK[required];
}

/**
 * For a viewer who may not write `docPath`: the path of the rule that still lets them append a new document there, or null.
 * That is a rule with `write: "anyone"`, and it holds for every visitor who can open the instance, signed in or not. Appending
 * means a new document under an id the server makes up, so nothing that exists can be overwritten; such documents count as data
 * from outside (see `InstanceData.ingest`). Private areas never take appends: rules cannot loosen them.
 */
export function appendRule(rules: DbRule[] | undefined, viewer: Viewer, docPath: string): string | null {
  const segs = docPath.split('/');
  if (privateAreaAllows(viewer, segs, 'write') !== null) return null;
  if (RANK[viewer.level] < RANK[DEFAULT_READ]) return null;
  const rule = deciding(rules, viewer, segs, 'write');
  return rule.level === ANYONE ? rule.path : null;
}

export function canRead(rules: DbRule[] | undefined, viewer: Viewer, path: string): boolean {
  return check(rules, viewer, path, 'read');
}

export function canWrite(rules: DbRule[] | undefined, viewer: Viewer, path: string): boolean {
  return check(rules, viewer, path, 'write');
}

export function canDelete(rules: DbRule[] | undefined, viewer: Viewer, path: string): boolean {
  return check(rules, viewer, path, 'delete');
}
