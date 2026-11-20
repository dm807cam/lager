import { describe, expect, it } from 'vitest';
import { appendRule, canDelete, canRead, canWrite, type Viewer } from '../src/data/rules.js';

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

  it('a narrower rule that sets only one kind inherits the other from the broader rule', () => {
    const rules = [
      { path: 'admin', read: 'admin' as const, write: 'admin' as const },
      { path: 'admin/log', write: 'owner' as const },
      { path: 'admin/log/public', read: 'view' as const },
    ];
    expect(canRead(rules, vw, 'admin/log/e1')).toBe(false);
    expect(canRead(rules, anon, 'admin/log/e1')).toBe(false);
    expect(canRead(rules, { userId: 'm', level: 'admin' }, 'admin/log/e1')).toBe(true);
    expect(canWrite(rules, { userId: 'm', level: 'admin' }, 'admin/log/e1')).toBe(false);
    expect(canWrite(rules, owner, 'admin/log/e1')).toBe(true);
    // the narrowest rule decides reading, the middle one still decides writing
    expect(canRead(rules, vw, 'admin/log/public/p1')).toBe(true);
    expect(canWrite(rules, { userId: 'm', level: 'admin' }, 'admin/log/public/p1')).toBe(false);
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

  it('a viewer reads their own private area but cannot write to it; a contributor can', () => {
    expect(canRead(undefined, vw, 'data/users/v/prefs/p')).toBe(true);
    expect(canWrite(undefined, vw, 'data/users/v/prefs/p')).toBe(false);
    // rules cannot loosen it either
    expect(canWrite([{ path: 'data', write: 'view' as const }], vw, 'data/users/v/prefs/p')).toBe(false);
    expect(canWrite(undefined, ed, 'data/users/e/prefs/p')).toBe(true);
    expect(canWrite(undefined, ed, 'data/users/v/prefs/p')).toBe(false);
    expect(canRead(undefined, none, 'data/users/x/prefs/p')).toBe(false);
  });

  it('deleting is a write, except in one\'s own private area where a viewer may too', () => {
    expect(canDelete(undefined, vw, 'data/users/v/prefs/p')).toBe(true);
    expect(canDelete(undefined, vw, 'data/users/e/prefs/p')).toBe(false);
    expect(canDelete(undefined, owner, 'data/users/v/prefs/p')).toBe(false);
    expect(canDelete(undefined, none, 'data/users/x/prefs/p')).toBe(false);
    expect(canDelete(undefined, anon, 'data/users/v/prefs/p')).toBe(false);
    expect(canDelete(undefined, vw, 'tasks/t')).toBe(false);
    expect(canDelete(undefined, ed, 'tasks/t')).toBe(true);
    expect(canDelete([{ path: 'tasks', write: 'owner' as const }], ed, 'tasks/t')).toBe(false);
  });

  it('anonymous never writes', () => {
    expect(canWrite([{ path: 'open', write: 'view' }], anon, 'open/x')).toBe(false);
    expect(canWrite([{ path: 'open', write: 'view' }], vw, 'open/x')).toBe(true);
  });

  it('none level is held by nobody', () => {
    const rules = [{ path: 'locked', read: 'none' as never, write: 'none' as never }];
    for (const v of [owner, ed, vw, anon, none]) {
      expect(canRead(rules, v, 'locked/x')).toBe(false);
      expect(canWrite(rules, v, 'locked/x')).toBe(false);
    }
  });

  describe('write: "anyone"', () => {
    const rules = [{ path: 'rsvps', read: 'admin' as const, write: 'anyone' as const }];

    it('lets every visitor who can open the instance append, signed in or not, and nobody without access', () => {
      expect(appendRule(rules, anon, 'rsvps/r1')).toBe('rsvps');
      expect(appendRule(rules, vw, 'rsvps/r1')).toBe('rsvps');
      expect(appendRule(rules, none, 'rsvps/r1')).toBeNull();
      expect(appendRule(rules, { userId: null, level: 'none' }, 'rsvps/r1')).toBeNull();
      // Below the rule's path too, and nowhere else.
      expect(appendRule(rules, anon, 'rsvps/r1/comments/c1')).toBe('rsvps');
      expect(appendRule(rules, anon, 'tasks/t1')).toBeNull();
      expect(appendRule(undefined, anon, 'rsvps/r1')).toBeNull();
    });

    it('opens nothing but appending: writing, changing and deleting stay where they are without the rule', () => {
      for (const v of [anon, vw, none]) {
        expect(canWrite(rules, v, 'rsvps/r1')).toBe(false);
        expect(canDelete(rules, v, 'rsvps/r1')).toBe(false);
      }
      expect(canWrite(rules, ed, 'rsvps/r1')).toBe(true);
      expect(canDelete(rules, ed, 'rsvps/r1')).toBe(true);
      // Reading is a rule of its own.
      expect(canRead(rules, anon, 'rsvps/r1')).toBe(false);
      expect(canRead(rules, owner, 'rsvps/r1')).toBe(true);
    });

    it('leaves a stricter rule above it in charge of changing and deleting', () => {
      // Guests append to the inbox of a form; only managers change what is there, as the broader rule says.
      const form = [{ path: 'forms', read: 'admin' as const, write: 'admin' as const }, { path: 'forms/f1/inbox', write: 'anyone' as const }];
      const manager: Viewer = { userId: 'm', level: 'admin' };
      expect(appendRule(form, anon, 'forms/f1/inbox/x')).toBe('forms/f1/inbox');
      expect(canWrite(form, ed, 'forms/f1/inbox/x')).toBe(false);
      expect(canDelete(form, ed, 'forms/f1/inbox/x')).toBe(false);
      expect(canWrite(form, manager, 'forms/f1/inbox/x')).toBe(true);
      // The rule set answers every other question exactly as it does without the anyone rule.
      const without = form.slice(0, 1);
      for (const v of [owner, manager, ed, vw, anon, none]) {
        for (const p of ['forms/f1/inbox/x', 'forms/f1', 'tasks/t1']) {
          expect([canRead(form, v, p), canWrite(form, v, p), canDelete(form, v, p)], `${v.level} ${p}`).toEqual([canRead(without, v, p), canWrite(without, v, p), canDelete(without, v, p)]);
        }
      }
      // A contributor who may not write there appends like every other visitor.
      expect(appendRule(form, ed, 'forms/f1/inbox/x')).toBe('forms/f1/inbox');
    });

    it('a more specific rule closes a part of the path again', () => {
      const nested = [...rules, { path: 'rsvps/closed', write: 'owner' as const }];
      expect(appendRule(nested, anon, 'rsvps/open/x/y')).toBe('rsvps');
      expect(appendRule(nested, anon, 'rsvps/closed/x/y')).toBeNull();
      expect(canWrite(nested, ed, 'rsvps/closed/x/y')).toBe(false);
    });

    it('never reaches a private area, and {self} never matches a guest', () => {
      const wide = [{ path: 'data', write: 'anyone' as const }, { path: 'votes/{self}', write: 'anyone' as const }];
      expect(appendRule(wide, anon, 'data/users/v/drafts/d1')).toBeNull();
      expect(appendRule(wide, vw, 'data/users/v/drafts/d1')).toBeNull();
      expect(appendRule(wide, vw, 'data/users/someone-else/drafts/d1')).toBeNull();
      expect(appendRule(wide, anon, 'votes/v/x/y')).toBeNull();
      expect(appendRule(wide, vw, 'votes/v/x/y')).toBe('votes/{self}');
    });

    it('is not a level for reading: such a rule closes the path to everyone', () => {
      const bad = [{ path: 'rsvps', read: 'anyone' as never }];
      for (const v of [owner, ed, vw, anon]) expect(canRead(bad, v, 'rsvps/r1')).toBe(false);
    });
  });
});
