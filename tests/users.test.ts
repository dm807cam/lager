import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LagerError } from '../src/errors.js';
import { openPlatformDb } from '../src/platform/db.js';
import { MIN_PASSWORD_LENGTH, Users } from '../src/platform/users.js';

let db: ReturnType<typeof openPlatformDb>;
let users: Users;
beforeEach(() => {
  db = openPlatformDb(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-users-')));
  users = new Users(db);
});

describe('Users', () => {
  it('creates and verifies', () => {
    const u = users.create({ email: 'Ann@Example.com', name: 'Ann', password: 'pw-123', role: 'publisher' });
    expect(u.role).toBe('publisher');
    expect(users.verifyPassword('Ann@Example.com', 'pw-123')).toEqual(u);
    expect(users.verifyPassword('ann@example.com', 'pw-123')?.id).toBe(u.id);
    expect(users.verifyPassword('ann@example.com', 'wrong')).toBeNull();
    expect(users.verifyPassword('nobody@example.com', 'pw-123')).toBeNull();
    expect(users.get(u.id)).toEqual(u);
    expect(users.getByEmail('ANN@example.com')).toEqual(u);
    expect(users.list()).toHaveLength(1);
  });

  it('rejects duplicate email', () => {
    users.create({ email: 'a@b.c', name: 'A', password: 'x', role: 'user' });
    try {
      users.create({ email: 'A@B.C', name: 'B', password: 'y', role: 'user' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LagerError);
      expect((e as LagerError).code).toBe('conflict');
    }
  });

  it('ensureAdmin only on empty db', () => {
    users.ensureAdmin('admin@x.y', 'secret');
    users.ensureAdmin('other@x.y', 'secret');
    expect(users.count()).toBe(1);
    expect(users.list()[0].role).toBe('admin');
    expect(users.list()[0].email).toBe('admin@x.y');
  });

  it('ensureAdmin does nothing without credentials', () => {
    users.ensureAdmin(undefined, 'secret');
    users.ensureAdmin('a@b.c', undefined);
    expect(users.count()).toBe(0);
  });

  it('never stores the plain password', () => {
    users.create({ email: 'a@b.c', name: 'A', password: 'hunter2-plain', role: 'user' });
    const row = db.prepare('SELECT * FROM users').get();
    expect(JSON.stringify(row)).not.toContain('hunter2-plain');
  });

  it('new fields default', () => {
    const u = users.create({ email: 'a@b.c', name: 'A', password: 'x', role: 'user' });
    expect(u).toMatchObject({ verified: true, disabled: false, sessionEpoch: 0 });
    expect(users.get(u.id)).toMatchObject({ verified: true, disabled: false, sessionEpoch: 0 });
    const v = users.create({ email: 'v@b.c', name: 'V', password: 'x', role: 'user', verified: false });
    expect(v.verified).toBe(false);
    expect(users.get(v.id)?.verified).toBe(false);
  });

  it('checkLogin reasons', () => {
    const a = users.create({ email: 'a@b.c', name: 'A', password: 'correct-horse', role: 'user' });
    users.create({ email: 'u@b.c', name: 'U', password: 'correct-horse', role: 'user', verified: false });
    expect(users.checkLogin('a@b.c', 'correct-horse')).toMatchObject({ ok: true, user: { id: a.id } });
    expect(users.checkLogin('a@b.c', 'wrong')).toEqual({ ok: false, reason: 'invalid' });
    expect(users.checkLogin('nobody@b.c', 'wrong')).toEqual({ ok: false, reason: 'invalid' });
    expect(users.checkLogin('u@b.c', 'correct-horse')).toEqual({ ok: false, reason: 'unverified' });
    expect(users.checkLogin('u@b.c', 'wrong')).toEqual({ ok: false, reason: 'invalid' });
    users.create({ email: 'root@b.c', name: 'R', password: 'correct-horse', role: 'admin' });
    users.setDisabled(a.id, true);
    expect(users.checkLogin('a@b.c', 'correct-horse')).toEqual({ ok: false, reason: 'disabled' });
    expect(users.checkLogin('a@b.c', 'wrong')).toEqual({ ok: false, reason: 'invalid' });
    expect(users.verifyPassword('a@b.c', 'correct-horse')).toBeNull();
  });

  it('cannot demote or disable the last active admin', () => {
    const a1 = users.create({ email: 'a1@b.c', name: 'A1', password: 'x', role: 'admin' });
    const conflict = expect.objectContaining({ code: 'conflict' });
    expect(() => users.setRole(a1.id, 'user')).toThrow(conflict);
    expect(() => users.setDisabled(a1.id, true)).toThrow(conflict);
    const a2 = users.create({ email: 'a2@b.c', name: 'A2', password: 'x', role: 'admin' });
    expect(users.setRole(a1.id, 'publisher').role).toBe('publisher');
    // a2 is now the only admin again
    expect(() => users.setDisabled(a2.id, true)).toThrow(conflict);
    users.setRole(a1.id, 'admin');
    expect(users.setDisabled(a2.id, true).disabled).toBe(true);
    // a disabled admin does not count
    expect(() => users.setRole(a1.id, 'user')).toThrow(conflict);
    expect(() => users.setDisabled(a1.id, true)).toThrow(conflict);
    expect(users.setDisabled(a2.id, false).disabled).toBe(false);
    expect(users.setRole(a1.id, 'user').role).toBe('user');
  });

  it('setPassword enforces length and bumps the epoch', () => {
    const u = users.create({ email: 'a@b.c', name: 'A', password: 'old', role: 'user' });
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(() => users.setPassword(u.id, '123456789')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(users.get(u.id)?.sessionEpoch).toBe(0);
    users.setPassword(u.id, '1234567890');
    expect(users.get(u.id)?.sessionEpoch).toBe(1);
    expect(users.verifyPassword('a@b.c', 'old')).toBeNull();
    expect(users.verifyPassword('a@b.c', '1234567890')?.id).toBe(u.id);
  });

  it('disabling bumps the epoch, enabling does not', () => {
    users.create({ email: 'root@b.c', name: 'R', password: 'x', role: 'admin' });
    const u = users.create({ email: 'a@b.c', name: 'A', password: 'x', role: 'user' });
    users.setDisabled(u.id, true);
    expect(users.get(u.id)?.sessionEpoch).toBe(1);
    users.setDisabled(u.id, false);
    expect(users.get(u.id)?.sessionEpoch).toBe(1);
    users.bumpEpoch(u.id);
    expect(users.get(u.id)?.sessionEpoch).toBe(2);
  });

  it('setName trims and validates, markVerified verifies', () => {
    const u = users.create({ email: 'a@b.c', name: 'A', password: 'x', role: 'user', verified: false });
    expect(users.setName(u.id, '  Anna  ').name).toBe('Anna');
    expect(() => users.setName(u.id, '   ')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(() => users.setName(u.id, 'x'.repeat(81))).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    users.markVerified(u.id);
    expect(users.get(u.id)?.verified).toBe(true);
  });

  it('create rejects an unknown role', () => {
    expect(() => users.create({ email: 'a@b.c', name: 'A', password: 'x', role: 'root' as never }))
      .toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });
});
