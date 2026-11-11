import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LagerError } from '../src/errors.js';
import { openPlatformDb } from '../src/platform/db.js';
import { Users } from '../src/platform/users.js';

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
});
