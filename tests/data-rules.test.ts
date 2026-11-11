import { describe, expect, it } from 'vitest';
import { canRead, canWrite, type Viewer } from '../src/data/rules.js';

const owner: Viewer = { userId: 'o', level: 'owner' };
const ed: Viewer = { userId: 'e', level: 'interact' };
const vw: Viewer = { userId: 'v', level: 'view' };
const anon: Viewer = { userId: null, level: 'view' };
const none: Viewer = { userId: 'x', level: 'none' };

describe('rules', () => {
  it('defaults', () => {
    for (const v of [owner, ed, vw, anon]) expect(canRead(undefined, v, 'tasks/t')).toBe(true);
    expect(canRead(undefined, none, 'tasks/t')).toBe(false);
    expect(canWrite(undefined, owner, 'tasks/t')).toBe(true);
    expect(canWrite(undefined, ed, 'tasks/t')).toBe(true);
    for (const v of [vw, anon, none]) expect(canWrite(undefined, v, 'tasks/t')).toBe(false);
  });

  it('prefix rule raises minimum', () => {
    const rules = [{ path: 'votes', read: 'view' as const, write: 'owner' as const }];
    expect(canWrite(rules, ed, 'votes/a')).toBe(false);
    expect(canWrite(rules, owner, 'votes/a')).toBe(true);
    expect(canWrite(rules, ed, 'tasks/t')).toBe(true);
    expect(canRead(rules, vw, 'votes')).toBe(true);
  });

  it('{self} rule', () => {
    const rules = [
      { path: 'votes', read: 'view' as const, write: 'owner' as const },
      { path: 'votes/{self}', write: 'interact' as const },
    ];
    expect(canWrite(rules, ed, 'votes/e')).toBe(true);
    expect(canWrite(rules, ed, 'votes/v')).toBe(false);
    expect(canWrite(rules, owner, 'votes/e')).toBe(true);
    expect(canWrite(rules, owner, 'votes/v')).toBe(true);
    expect(canRead(rules, vw, 'votes/e')).toBe(true);
  });

  it('most specific rule wins', () => {
    const rules = [
      { path: 'a', write: 'owner' as const },
      { path: 'a/b/c', write: 'interact' as const },
    ];
    expect(canWrite(rules, ed, 'a/b/c/d')).toBe(true);
    expect(canWrite(rules, ed, 'a/b/x')).toBe(false);
  });

  it('self level is held by nobody', () => {
    const rules = [
      { path: 'signoffs', read: 'view' as const, write: 'self' as const },
      { path: 'signoffs/{self}', read: 'view' as const, write: 'interact' as const },
    ];
    expect(canWrite(rules, owner, 'signoffs/e')).toBe(false);
    expect(canWrite(rules, ed, 'signoffs/e')).toBe(true);
    expect(canWrite(rules, ed, 'signoffs/v')).toBe(false);
  });

  it('private user area', () => {
    const rules = [{ path: 'data', read: 'view' as const, write: 'view' as const }];
    expect(canRead(rules, ed, 'data/users/e/x')).toBe(true);
    expect(canWrite(rules, ed, 'data/users/e/x')).toBe(true);
    expect(canRead(undefined, owner, 'data/users/e/x')).toBe(false);
    expect(canWrite(undefined, owner, 'data/users/e/x')).toBe(false);
    expect(canRead(undefined, anon, 'data/users/e/x')).toBe(false);
    expect(canRead(undefined, ed, 'data/users')).toBe(false);
    expect(canRead(undefined, ed, 'data/users/v')).toBe(false);
  });

  it('anonymous never writes', () => {
    expect(canWrite([{ path: 'open', write: 'view' }], anon, 'open/x')).toBe(false);
    expect(canWrite([{ path: 'open', write: 'view' }], vw, 'open/x')).toBe(true);
  });
});
