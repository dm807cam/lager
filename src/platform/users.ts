import crypto from 'node:crypto';
import { promisify } from 'node:util';
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

/**
 * Password hashes computed at the same time, and how many more may wait their turn. scrypt runs on the thread pool, which file and
 * DNS work share (four threads by default): a burst of sign-ins must leave half of it free, and must not queue without end.
 */
export const MAX_HASHES_IN_FLIGHT = 2;
export const MAX_HASHES_WAITING = 32;
let hashing = 0;
const waiting: Array<() => void> = [];

const scryptAsync = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>;

/** scrypt off the event loop, at most `MAX_HASHES_IN_FLIGHT` at a time; with the queue full the caller is told to come back (`rate_limited`). */
async function scrypt(password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions): Promise<Buffer> {
  if (hashing < MAX_HASHES_IN_FLIGHT) hashing++;
  else if (waiting.length >= MAX_HASHES_WAITING) throw new LagerError('rate_limited', 'Too many passwords are being checked at the moment. Please try again shortly.', 'busy');
  // Whoever finishes hands its slot to the next in line, so the count stays as it is.
  else await new Promise<void>((turn) => { waiting.push(turn); });
  try {
    return await scryptAsync(password, salt, keylen, options);
  } finally {
    const next = waiting.shift();
    if (next) next(); else hashing--;
  }
}
const encode = (salt: Buffer, hash: Buffer): string => `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;

/** The stored form of a password. Hash before opening a transaction: nothing may be awaited inside one. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return encode(salt, await scrypt(password, salt, KEY_LEN, SCRYPT));
}

/** Blocks the process for one hash: only where nothing is being served yet, as for the first administrator at startup. */
function hashPasswordSync(password: string): string {
  const salt = crypto.randomBytes(16);
  return encode(salt, crypto.scryptSync(password, salt, KEY_LEN, SCRYPT));
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// Used to spend comparable time when the email is unknown.
const DUMMY_HASH = hashPasswordSync(crypto.randomUUID());

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

  /** `passwordHash` is what `hashPassword` returned for `password`; without it the password is hashed here, synchronously. */
  create(input: { email: string; name: string; password: string; passwordHash?: string; role: Role; verified?: boolean; locale?: Locale | null }): User {
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
      .run(id, email, input.name, input.role, input.passwordHash ?? hashPasswordSync(input.password), createdAt, verified ? createdAt : null, locale);
    return { id, email, name: input.name, role: input.role, createdAt, verified, disabled: false, sessionEpoch: 0, locale };
  }

  /** The password is always checked first, so the reason never leaks whether an account exists or is blocked. */
  async checkLogin(email: string, password: string): Promise<LoginResult> {
    const found = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    if (!found) {
      await checkPassword(password, DUMMY_HASH);
      return { ok: false, reason: 'invalid' };
    }
    if (!(await checkPassword(password, found.password_hash))) return { ok: false, reason: 'invalid' };
    // Read again: the account may have been disabled, or its password replaced, while the hash was computed.
    const row = this.db.prepare('SELECT * FROM users WHERE id = ? AND password_hash = ?').get(found.id, found.password_hash) as UserRow | undefined;
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.disabled_at !== null) return { ok: false, reason: 'disabled' };
    if (row.verified_at === null) return { ok: false, reason: 'unverified' };
    return { ok: true, user: toUser(row) };
  }

  async verifyPassword(email: string, password: string): Promise<User | null> {
    const r = await this.checkLogin(email, password);
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
  /** `passwordHash` is what `hashPassword` returned for `password`, for a caller that must hash before it commits to anything. */
  async setPassword(id: string, password: string, passwordHash?: string): Promise<void> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new LagerError('invalid_argument', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'password_short');
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new LagerError('invalid_argument', `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`, 'password_long');
    }
    this.require(id);
    const hash = passwordHash ?? await hashPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(hash, id);
    for (const hook of this.passwordHooks) hook(id);
  }

  markVerified(id: string): void {
    this.db.prepare('UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * A short digest of the stored password hash: it changes with the password and with nothing else. The device cookie carries it,
   * so a browser that knew an older password stops counting as known, while a sign-out changes nothing.
   */
  passwordMark(id: string): string | null {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string } | undefined;
    return row ? crypto.createHash('sha256').update(row.password_hash).digest('base64url').slice(0, 16) : null;
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
