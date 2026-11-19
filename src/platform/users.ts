import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';
import { isLocale, type Locale } from '../i18n/index.js';

export type Role = 'admin' | 'publisher' | 'user';
export const MIN_PASSWORD_LENGTH = 10;
/** Far above any passphrase, and well inside the 10 kB a form may carry. A longer password is refused, never shortened. */
export const MAX_PASSWORD_LENGTH = 1024;
const ROLES: readonly Role[] = ['admin', 'publisher', 'user'];
const MAX_NAME = 80;
export const MAX_NAME_LENGTH = MAX_NAME;

export interface User {
  id: string; email: string; name: string; role: Role; createdAt: string;
  verified: boolean; disabled: boolean; sessionEpoch: number;
  /** The language chosen for this account, or null to follow the browser. */
  locale: Locale | null;
}
export type LoginResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'unverified' | 'disabled' };

interface UserRow {
  id: string; email: string; name: string; role: Role; password_hash: string; created_at: string;
  verified_at: string | null; disabled_at: string | null; session_epoch: number; locale: string | null;
}

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// Used to spend comparable time when the email is unknown.
const DUMMY_HASH = hashPassword(crypto.randomUUID());

function toUser(r: UserRow): User {
  return {
    id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at,
    verified: r.verified_at !== null, disabled: r.disabled_at !== null, sessionEpoch: r.session_epoch,
    locale: isLocale(r.locale) ? r.locale : null,
  };
}

export class Users {
  private passwordHooks: Array<(userId: string) => void> = [];
  private disabledHooks: Array<(userId: string) => void> = [];
  private demotedHooks: Array<(userId: string) => void> = [];

  constructor(private db: DatabaseSync) {}

  /** Runs after every password replacement (account page, recovery). Lets other modules drop credentials they hold for the account. */
  onPasswordChanged(hook: (userId: string) => void): void { this.passwordHooks.push(hook); }
  /** Runs after an account has been disabled. */
  onDisabled(hook: (userId: string) => void): void { this.disabledHooks.push(hook); }
  /** Runs after an administrator lost the role. */
  onDemoted(hook: (userId: string) => void): void { this.demotedHooks.push(hook); }

  create(input: { email: string; name: string; password: string; role: Role; verified?: boolean; locale?: Locale | null }): User {
    const email = input.email.trim();
    if (!email) throw new LagerError('invalid_argument', 'Email is required.');
    if (!input.password) throw new LagerError('invalid_argument', 'Password is required.');
    if (!ROLES.includes(input.role)) throw new LagerError('invalid_argument', `Unknown role "${String(input.role)}".`);
    if (this.getByEmail(email)) throw new LagerError('conflict', `A user with email ${email} already exists.`, 'email_taken');
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const verified = input.verified ?? true;
    const locale = isLocale(input.locale) ? input.locale : null;
    this.db
      .prepare('INSERT INTO users (id, email, name, role, password_hash, created_at, verified_at, locale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, email, input.name, input.role, hashPassword(input.password), createdAt, verified ? createdAt : null, locale);
    return { id, email, name: input.name, role: input.role, createdAt, verified, disabled: false, sessionEpoch: 0, locale };
  }

  /** The password is always checked first, so the reason never leaks whether an account exists or is blocked. */
  checkLogin(email: string, password: string): LoginResult {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    if (!row) {
      checkPassword(password, DUMMY_HASH);
      return { ok: false, reason: 'invalid' };
    }
    if (!checkPassword(password, row.password_hash)) return { ok: false, reason: 'invalid' };
    if (row.disabled_at !== null) return { ok: false, reason: 'disabled' };
    if (row.verified_at === null) return { ok: false, reason: 'unverified' };
    return { ok: true, user: toUser(row) };
  }

  verifyPassword(email: string, password: string): User | null {
    const r = this.checkLogin(email, password);
    return r.ok ? r.user : null;
  }

  private require(id: string): UserRow {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!row) throw new LagerError('not_found', 'User not found.');
    return row;
  }

  /** Throws a conflict if `id` is an active admin and is the last one. */
  private assertNotLastActiveAdmin(row: UserRow): void {
    if (row.role !== 'admin' || row.disabled_at !== null) return;
    const others = (this.db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?")
      .get(row.id) as { c: number }).c;
    if (others === 0) throw new LagerError('conflict', 'There must be at least one active administrator.');
  }

  setRole(id: string, role: Role): User {
    if (!ROLES.includes(role)) throw new LagerError('invalid_argument', `Unknown role "${String(role)}".`);
    const row = this.require(id);
    if (role !== 'admin') this.assertNotLastActiveAdmin(row);
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (row.role === 'admin' && role !== 'admin') for (const hook of this.demotedHooks) hook(id);
    return toUser(this.require(id));
  }

  setDisabled(id: string, disabled: boolean): User {
    const row = this.require(id);
    if (disabled) {
      this.assertNotLastActiveAdmin(row);
      this.db
        .prepare('UPDATE users SET disabled_at = COALESCE(disabled_at, ?), session_epoch = session_epoch + 1 WHERE id = ?')
        .run(new Date().toISOString(), id);
      for (const hook of this.disabledHooks) hook(id);
      // An administrator who is disabled no longer vouches for the invitations they issued.
      if (row.role === 'admin') for (const hook of this.demotedHooks) hook(id);
    } else {
      this.db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(id);
    }
    return toUser(this.require(id));
  }

  setName(id: string, name: string): User {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > MAX_NAME) throw new LagerError('invalid_argument', `Name must be 1 to ${MAX_NAME} characters.`, 'name_invalid');
    this.require(id);
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(trimmed, id);
    return toUser(this.require(id));
  }

  /** Stores the account's language; `null` goes back to following the browser. */
  setLocale(id: string, locale: Locale | null): User {
    if (locale !== null && !isLocale(locale)) throw new LagerError('invalid_argument', `Unknown locale "${String(locale)}".`, 'locale_invalid');
    this.require(id);
    this.db.prepare('UPDATE users SET locale = ? WHERE id = ?').run(locale, id);
    return toUser(this.require(id));
  }

  /** Replaces the password and invalidates existing sessions. */
  setPassword(id: string, password: string): void {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new LagerError('invalid_argument', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'password_short');
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new LagerError('invalid_argument', `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`, 'password_long');
    }
    this.require(id);
    this.db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(hashPassword(password), id);
    for (const hook of this.passwordHooks) hook(id);
  }

  markVerified(id: string): void {
    this.db.prepare('UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE id = ?').run(new Date().toISOString(), id);
  }

  /** Invalidates all sessions of the user. */
  bumpEpoch(id: string): void {
    this.db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run(id);
  }

  get(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  getByEmail(email: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  list(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at, email').all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  }

  ensureAdmin(email?: string, password?: string): void {
    if (!email || !password || this.count() > 0) return;
    this.create({ email, name: 'Admin', password, role: 'admin' });
  }
}
