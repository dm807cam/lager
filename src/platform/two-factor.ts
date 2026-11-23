import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';

/**
 * Two-step sign-in: a time-based one-time code (TOTP, RFC 6238) from an authenticator app, or a single-use recovery code, after
 * the password. SHA-1, six digits and thirty seconds are what every authenticator app understands; the strength comes from the
 * 160-bit secret, the single use of every time step and the limits below, not from the hash.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Time steps accepted on either side of the current one, for clocks that are a little off. */
const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;
/** A secret that was shown but never confirmed with a code is worthless after this time. */
export const SETUP_TTL_MS = 15 * 60_000;
export const RECOVERY_CODE_COUNT = 10;
/** Twelve characters of base32: 60 bits each, stored only as a keyed hash. */
const RECOVERY_CODE_LENGTH = 12;
/** Wrong codes in a row before the second step of the account pauses. */
export const MAX_CODE_FAILURES = 5;
/** How long it then pauses: the first time, and each further time without a right code in between. Never longer than the last step. */
export const CODE_LOCK_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 8 * 3600_000, 24 * 3600_000];
/** Each full day without a wrong code, counted from the end of the last pause, takes the pauses back one step. */
const LOCK_LEVEL_RESET_MS = 24 * 3600_000;
/** Longest input looked at; anything longer is a wrong code. */
export const MAX_CODE_INPUT = 64;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) of one counter value, as a zero-padded decimal string. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);

/** The `otpauth://` address authenticator apps read; `issuer` tells two servers apart in the app. */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** A code as typed: spaces and dashes go, letters are compared in capitals. */
const normalize = (code: string): string => code.replace(/[\s-]/g, '').toUpperCase();
const isTotpInput = (code: string): boolean => new RegExp(`^[0-9]{${TOTP_DIGITS}}$`).test(code);
const isRecoveryInput = (code: string): boolean => new RegExp(`^[${BASE32}]{${RECOVERY_CODE_LENGTH}}$`).test(code);

/** `XXXX-XXXX-XXXX`, the form recovery codes are shown in. */
const formatRecovery = (code: string): string => code.match(/.{1,4}/g)!.join('-');

export interface TwoFactorStatus {
  /** True once a code confirmed the secret: from then on signing in needs a code. */
  enabled: boolean;
  confirmedAt: string | null;
  /** Recovery codes not used yet. */
  recoveryLeft: number;
  /** True when the stored secret no longer decrypts (the server secret was replaced): no code works, an administrator must turn it off. */
  unreadable: boolean;
}

export type CodeCheck =
  | { ok: true; method: 'totp' | 'recovery'; recoveryLeft: number }
  | { ok: false; reason: 'wrong' }
  /** `until` is when codes are looked at again; `started` is true for the wrong code that began this pause. */
  | { ok: false; reason: 'locked'; until: number; started: boolean };

interface Row {
  user_id: string; secret_enc: string; created_at: string; confirmed_at: string | null;
  last_step: number; failures: number; lock_level: number; locked_until: number; last_failure_at: number;
}

/**
 * The second factor of every account that turned it on. The TOTP secret is encrypted with a key of its own derived from the
 * server secret, bound to the account it belongs to, so a copy of the database alone neither reveals it nor lets one account's
 * secret be moved to another. Recovery codes are stored as a keyed hash, so a copy of the database cannot be searched for them.
 *
 * Wrong codes are counted in the database, per account, whatever browser or address they come from, and survive a restart: the
 * password is already known to whoever reaches this step, so the count is all that stands between them and the account.
 */
export class TwoFactor {
  private encKey: Buffer;
  private hashKey: Buffer;

  constructor(private db: DatabaseSync, secret: string) {
    const derive = (info: string): Buffer => Buffer.from(crypto.hkdfSync('sha256', secret, 'lager-two-factor', info, 32));
    this.encKey = derive('totp-secret-v1');
    this.hashKey = derive('recovery-code-v1');
  }

  private encrypt(userId: string, plain: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    cipher.setAAD(Buffer.from(`user:${userId}`));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  /** Null when the value is damaged, belongs to another account, or the server secret changed since it was stored. */
  private decrypt(userId: string, stored: string): Buffer | null {
    const [v, iv, tag, ct] = stored.split(':');
    if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
      d.setAAD(Buffer.from(`user:${userId}`));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
    } catch {
      return null;
    }
  }

  private recoveryHash(userId: string, normalized: string): string {
    return crypto.createHmac('sha256', this.hashKey).update(`${userId}\n${normalized}`).digest('hex');
  }

  private row(userId: string): Row | null {
    return (this.db.prepare('SELECT * FROM user_two_factor WHERE user_id = ?').get(userId) as Row | undefined) ?? null;
  }

  private recoveryLeft(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM user_recovery_codes WHERE user_id = ?').get(userId) as { c: number }).c;
  }

  /** True when signing in to the account needs a second step. */
  isEnabled(userId: string): boolean {
    return this.row(userId)?.confirmed_at != null;
  }

  status(userId: string): TwoFactorStatus {
    const row = this.row(userId);
    const enabled = row?.confirmed_at != null;
    return {
      enabled, confirmedAt: enabled ? row!.confirmed_at : null, recoveryLeft: enabled ? this.recoveryLeft(userId) : 0,
      unreadable: enabled && this.decrypt(userId, row!.secret_enc) === null,
    };
  }

  /**
   * A new secret for the account, not in force until `confirmSetup` sees a code made from it. Replaces a secret that was shown
   * before and never confirmed. Refused while two-step sign-in is on: turning it off first needs a code.
   */
  startSetup(userId: string, now = Date.now()): string {
    if (this.isEnabled(userId)) throw new LagerError('conflict', 'Two-step sign-in is already on.', 'two_factor_on');
    const secret = crypto.randomBytes(SECRET_BYTES);
    this.db.prepare(`INSERT INTO user_two_factor (user_id, secret_enc, created_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc, created_at = excluded.created_at, confirmed_at = NULL,
        last_step = 0, failures = 0, lock_level = 0, locked_until = 0, last_failure_at = 0`)
      .run(userId, this.encrypt(userId, secret), new Date(now).toISOString());
    return base32Encode(secret);
  }

  /**
   * A short digest that names the setup now pending (its encrypted secret and its start), or null when none is pending. The page
   * that shows the secret carries it in a signed form token, so only the browser that gave the password can see the secret
   * again or confirm it; a session alone, taken from somewhere else, cannot.
   */
  pendingMark(userId: string, now = Date.now()): string | null {
    const row = this.row(userId);
    if (!row || row.confirmed_at !== null || Date.parse(row.created_at) + SETUP_TTL_MS <= now) return null;
    return crypto.createHash('sha256').update(`${row.created_at}\n${row.secret_enc}`).digest('base64url').slice(0, 22);
  }

  /** The secret of a setup that was started, is not confirmed and has not expired; null otherwise. */
  pendingSecret(userId: string, now = Date.now()): string | null {
    const row = this.row(userId);
    if (!row || row.confirmed_at !== null || Date.parse(row.created_at) + SETUP_TTL_MS <= now) return null;
    const key = this.decrypt(userId, row.secret_enc);
    return key ? base32Encode(key) : null;
  }

  /** The time step `code` was made for, between `after` (exclusive) and the window around now; null if none. Every step is compared. */
  private matchStep(key: Buffer, code: string, after: number, now: number): number | null {
    const current = timeStep(now);
    let found: number | null = null;
    const typed = Buffer.from(code);
    for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
      const expected = Buffer.from(hotp(key, step));
      if (crypto.timingSafeEqual(expected, typed) && step > after && found === null) found = step;
    }
    return found;
  }

  /**
   * Turns two-step sign-in on when `code` was made from the pending secret, and returns the recovery codes, which exist only
   * in this answer. A wrong code leaves the setup as it was; the caller limits how often it may be tried.
   */
  confirmSetup(userId: string, code: string, now = Date.now()): string[] {
    const row = this.row(userId);
    if (!row || row.confirmed_at !== null || Date.parse(row.created_at) + SETUP_TTL_MS <= now) {
      throw new LagerError('invalid_argument', 'The setup has expired. Please start again.', 'two_factor_setup_expired');
    }
    const key = this.decrypt(userId, row.secret_enc);
    const typed = typeof code === 'string' ? normalize(code.slice(0, MAX_CODE_INPUT)) : '';
    const step = key && isTotpInput(typed) ? this.matchStep(key, typed, 0, now) : null;
    if (step === null) throw new LagerError('invalid_argument', 'The code is not right.', 'two_factor_code_wrong');
    let codes: string[] = [];
    this.db.exec('BEGIN');
    try {
      const changed = Number(this.db.prepare('UPDATE user_two_factor SET confirmed_at = ?, last_step = ? WHERE user_id = ? AND confirmed_at IS NULL AND secret_enc = ?')
        .run(new Date(now).toISOString(), step, userId, row.secret_enc).changes);
      if (changed === 0) throw new LagerError('invalid_argument', 'The setup has expired. Please start again.', 'two_factor_setup_expired');
      codes = this.replaceRecoveryCodes(userId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return codes;
  }

  /** Inside a transaction of the caller. */
  private replaceRecoveryCodes(userId: string): string[] {
    this.db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
    const insert = this.db.prepare('INSERT INTO user_recovery_codes (code_hash, user_id) VALUES (?, ?)');
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      // 60 random bits, drawn without bias: every byte gives one character (256 is a multiple of 32).
      const code = Array.from(crypto.randomBytes(RECOVERY_CODE_LENGTH), (b) => BASE32[b & 31]).join('');
      insert.run(this.recoveryHash(userId, code), userId);
      codes.push(formatRecovery(code));
    }
    return codes;
  }

  /** New recovery codes for an account with two-step sign-in on; the old ones stop working. */
  regenerateRecoveryCodes(userId: string): string[] {
    if (!this.isEnabled(userId)) throw new LagerError('conflict', 'Two-step sign-in is off.', 'two_factor_off');
    this.db.exec('BEGIN');
    try {
      const codes = this.replaceRecoveryCodes(userId);
      this.db.exec('COMMIT');
      return codes;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Checks a code for the second step of an account with two-step sign-in on: a code from the app, or a recovery code, which
   * is used up. While the account is paused nothing is looked at and nothing is counted. A code from the app is good once: its
   * time step and every earlier one are spent, also for a request that arrives at the same moment with the same code.
   */
  check(userId: string, code: string, now = Date.now()): CodeCheck {
    const row = this.row(userId);
    if (!row || row.confirmed_at === null) return { ok: false, reason: 'wrong' };
    if (now < row.locked_until) return { ok: false, reason: 'locked', until: row.locked_until, started: false };
    const typed = typeof code === 'string' && code.length <= MAX_CODE_INPUT ? normalize(code) : '';
    let method: 'totp' | 'recovery' | null = null;
    if (isTotpInput(typed)) {
      const key = this.decrypt(userId, row.secret_enc);
      const step = key ? this.matchStep(key, typed, row.last_step, now) : null;
      // Only one request can move the step on: a second one with the same code finds it spent.
      if (step !== null && Number(this.db.prepare('UPDATE user_two_factor SET last_step = ? WHERE user_id = ? AND last_step < ?').run(step, userId, step).changes) > 0) {
        method = 'totp';
      }
    } else if (isRecoveryInput(typed)) {
      if (Number(this.db.prepare('DELETE FROM user_recovery_codes WHERE code_hash = ? AND user_id = ?').run(this.recoveryHash(userId, typed), userId).changes) > 0) {
        method = 'recovery';
      }
    }
    if (method !== null) {
      // The run of wrong codes ends; the length of the next pause does not. It falls only with time, so the owner signing in now
      // and then does not hand an attacker short pauses again.
      this.db.prepare('UPDATE user_two_factor SET failures = 0 WHERE user_id = ?').run(userId);
      return { ok: true, method, recoveryLeft: this.recoveryLeft(userId) };
    }
    return this.fail(userId, now);
  }

  /**
   * Counts one wrong code. The new values are computed from the row as read and written only if the row still holds those
   * values; otherwise it is read again. Today nothing can come between the two (`check` awaits nothing and `DatabaseSync` is
   * synchronous), but the per-account limit must not depend on that: two wrong codes must never be counted as one.
   */
  private fail(userId: string, now: number): CodeCheck {
    for (;;) {
      const row = this.row(userId);
      if (!row) return { ok: false, reason: 'wrong' };
      // Another request may have started a pause in between.
      if (now < row.locked_until) return { ok: false, reason: 'locked', until: row.locked_until, started: false };
      const result = this.failOnce(row, now);
      if (result) return result;
    }
  }

  /** One attempt of `fail`: null when the row changed since it was read. */
  private failOnce(row: Row, now: number): CodeCheck | null {
    // Quiet counts from the end of the last pause, not from the code that began it, and each quiet day takes one step back, never
    // more: an attacker who waits gets back only as many short pauses as days went by, so over time no more than about
    // MAX_CODE_FAILURES codes a day are looked at, whatever the rhythm of the guesses.
    const quietDays = row.last_failure_at > 0 ? Math.floor((now - Math.max(row.last_failure_at, row.locked_until)) / LOCK_LEVEL_RESET_MS) : 0;
    let level = Math.max(0, row.lock_level - quietDays);
    let failures = (quietDays > 0 ? 0 : row.failures) + 1;
    let until = 0;
    if (failures >= MAX_CODE_FAILURES) {
      until = now + CODE_LOCK_STEPS_MS[Math.min(level, CODE_LOCK_STEPS_MS.length - 1)];
      level = Math.min(level + 1, CODE_LOCK_STEPS_MS.length - 1);
      failures = 0;
    }
    const changed = Number(this.db.prepare(`UPDATE user_two_factor SET failures = ?, lock_level = ?, locked_until = ?, last_failure_at = ?
      WHERE user_id = ? AND failures = ? AND lock_level = ? AND locked_until = ? AND last_failure_at = ?`)
      .run(failures, level, until, now, row.user_id, row.failures, row.lock_level, row.locked_until, row.last_failure_at).changes);
    if (changed === 0) return null;
    return until ? { ok: false, reason: 'locked', until, started: true } : { ok: false, reason: 'wrong' };
  }

  /** Turns two-step sign-in off and forgets the secret and the recovery codes. True if it was on or being set up. */
  disable(userId: string): boolean {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
      const changed = Number(this.db.prepare('DELETE FROM user_two_factor WHERE user_id = ?').run(userId).changes);
      this.db.exec('COMMIT');
      return changed > 0;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
