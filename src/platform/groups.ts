import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';
import type { User, Users } from './users.js';

export interface Group { id: string; name: string; createdAt: string; memberCount: number }

const MAX_NAME = 60;

interface GroupRow { id: string; name: string; created_at: string; member_count: number }

const SELECT = 'SELECT g.id, g.name, g.created_at, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count FROM groups g';
const toGroup = (r: GroupRow): Group => ({ id: r.id, name: r.name, createdAt: r.created_at, memberCount: r.member_count });

function cleanName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > MAX_NAME) throw new LagerError('invalid_argument', `Group name must be 1 to ${MAX_NAME} characters.`);
  return trimmed;
}

export class Groups {
  constructor(private db: DatabaseSync, private users: Users) {}

  private require(id: string): Group {
    const g = this.get(id);
    if (!g) throw new LagerError('not_found', 'Group not found.');
    return g;
  }

  private assertNameFree(name: string, exceptId?: string): void {
    const clash = this.getByName(name);
    if (clash && clash.id !== exceptId) throw new LagerError('conflict', `A group named "${name}" already exists.`);
  }

  create(name: string): Group {
    const clean = cleanName(name);
    this.assertNameFree(clean);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, clean, new Date().toISOString());
    return this.require(id);
  }

  rename(id: string, name: string): Group {
    const clean = cleanName(name);
    this.require(id);
    this.assertNameFree(clean, id);
    this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(clean, id);
    return this.require(id);
  }

  /** Removes the group together with its memberships and the grants given to it. */
  delete(id: string): void {
    this.require(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
      this.db.prepare("DELETE FROM grants WHERE principal_type = 'group' AND principal_id = ?").run(id);
      this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  list(): Group[] {
    return (this.db.prepare(`${SELECT} ORDER BY g.name`).all() as unknown as GroupRow[]).map(toGroup);
  }

  get(id: string): Group | null {
    const r = this.db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as GroupRow | undefined;
    return r ? toGroup(r) : null;
  }

  getByName(name: string): Group | null {
    const r = this.db.prepare(`${SELECT} WHERE g.name = ?`).get(typeof name === 'string' ? name.trim() : '') as GroupRow | undefined;
    return r ? toGroup(r) : null;
  }

  members(id: string): User[] {
    const rows = this.db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(id) as unknown as Array<{ user_id: string }>;
    return rows.map((r) => this.users.get(r.user_id)).filter((u): u is User => u !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  addMember(id: string, userId: string): void {
    this.require(id);
    if (!this.users.get(userId)) throw new LagerError('not_found', 'User not found.');
    this.db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, userId);
  }

  removeMember(id: string, userId: string): void {
    this.require(id);
    this.db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, userId);
  }

  groupsOf(userId: string): string[] {
    const rows = this.db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as unknown as Array<{ group_id: string }>;
    return rows.map((r) => r.group_id);
  }
}
