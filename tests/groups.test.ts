import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LagerError } from '../src/errors.js';
import { openPlatformDb } from '../src/platform/db.js';
import { Groups } from '../src/platform/groups.js';
import { Users, type User } from '../src/platform/users.js';

let db: ReturnType<typeof openPlatformDb>;
let users: Users;
let groups: Groups;
let a: User, b: User;

beforeEach(() => {
  db = openPlatformDb(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-groups-')));
  users = new Users(db);
  groups = new Groups(db, users);
  a = users.create({ email: 'a@x.y', name: 'A', password: 'pw', role: 'user' });
  b = users.create({ email: 'b@x.y', name: 'B', password: 'pw', role: 'user' });
});

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof LagerError) return e.code; throw e; }
  return 'none';
}

describe('Groups', () => {
  it('create, rename, delete, duplicate name', () => {
    const g = groups.create('Team Rot');
    expect(g).toMatchObject({ name: 'Team Rot', memberCount: 0 });
    expect(groups.get(g.id)?.name).toBe('Team Rot');
    expect(groups.getByName('team rot')?.id).toBe(g.id);
    expect(code(() => groups.create('TEAM ROT'))).toBe('conflict');
    expect(code(() => groups.create(''))).toBe('invalid_argument');
    expect(code(() => groups.create('x'.repeat(61)))).toBe('invalid_argument');
    const h = groups.create('Blau');
    expect(code(() => groups.rename(h.id, 'team rot'))).toBe('conflict');
    expect(groups.rename(h.id, 'Grün').name).toBe('Grün');
    expect(code(() => groups.rename('nope', 'X'))).toBe('not_found');
    expect(groups.list().map((x) => x.name).sort()).toEqual(['Grün', 'Team Rot']);

    groups.addMember(g.id, a.id);
    db.prepare("INSERT INTO grants (instance_id, principal_type, principal_id, level, created_at) VALUES ('i1','group',?, 'view', 'now')").run(g.id);
    db.prepare("INSERT INTO grants (instance_id, principal_type, principal_id, level, created_at) VALUES ('i1','user',?, 'view', 'now')").run(a.id);
    groups.delete(g.id);
    expect(groups.get(g.id)).toBeNull();
    expect(groups.groupsOf(a.id)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS c FROM grants WHERE principal_type = 'group'").get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM grants').get() as { c: number }).c).toBe(1);
    expect(code(() => groups.delete(g.id))).toBe('not_found');
  });

  it('members and groupsOf', () => {
    const g = groups.create('G');
    const h = groups.create('H');
    groups.addMember(g.id, a.id);
    groups.addMember(g.id, a.id);
    groups.addMember(g.id, b.id);
    groups.addMember(h.id, a.id);
    expect(groups.members(g.id).map((u) => u.id).sort()).toEqual([a.id, b.id].sort());
    expect(groups.get(g.id)?.memberCount).toBe(2);
    expect(groups.groupsOf(a.id).sort()).toEqual([g.id, h.id].sort());
    expect(code(() => groups.addMember(g.id, 'nope'))).toBe('not_found');
    expect(code(() => groups.addMember('nope', a.id))).toBe('not_found');
    groups.removeMember(g.id, a.id);
    expect(groups.groupsOf(a.id)).toEqual([h.id]);
    groups.removeMember(g.id, a.id);
  });
});
