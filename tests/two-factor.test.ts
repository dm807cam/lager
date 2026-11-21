import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openPlatformDb } from '../src/platform/db.js';
import {
  base32Decode, base32Encode, CODE_LOCK_STEPS_MS, hotp, MAX_CODE_FAILURES, otpauthUri, RECOVERY_CODE_COUNT, SETUP_TTL_MS, timeStep, TwoFactor,
} from '../src/platform/two-factor.js';
import { Users } from '../src/platform/users.js';

const open: DatabaseSync[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function setup(secret = 'server-secret'): { db: DatabaseSync; tf: TwoFactor; users: Users; userId: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-2fa-'));
  const db = openPlatformDb(dir);
  open.push(db);
  const users = new Users(db);
  const userId = users.create({ email: 'ann@example.org', name: 'Ann', password: 'password-123', role: 'user' }).id;
  return { db, tf: new TwoFactor(db, secret), users, userId, dir };
}

/** The code an authenticator app shows for `secret` at `now`, `offset` time steps away. */
const codeAt = (secret: string, now: number, offset = 0): string => hotp(base32Decode(secret)!, timeStep(now) + offset);

/** Two-step sign-in switched on at `now`; returns the secret and the recovery codes. */
function enable(tf: TwoFactor, userId: string, now: number): { secret: string; codes: string[] } {
  const secret = tf.startSetup(userId, now);
  return { secret, codes: tf.confirmSetup(userId, codeAt(secret, now), now) };
}

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);

describe('TOTP building blocks', () => {
  it('matches the SHA-1 test vectors of RFC 6238 (last six digits)', () => {
    const key = Buffer.from('12345678901234567890');
    const vectors: Array<[number, string]> = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [seconds, eight] of vectors) {
      expect(hotp(key, timeStep(seconds * 1000), 8)).toBe(eight);
      expect(hotp(key, timeStep(seconds * 1000))).toBe(eight.slice(2));
    }
  });

  it('base32 round-trips and refuses characters outside the alphabet', () => {
    const bytes = Buffer.from('12345678901234567890');
    expect(base32Encode(bytes)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(bytes);
    expect(base32Decode('gezdgnbv')).toEqual(Buffer.from('12345'));
    expect(base32Decode('GEZ1')).toBeNull();
  });

  it('builds an otpauth address that names the server and the account', () => {
    const uri = new URL(otpauthUri('ABCD', 'Lager (lager.example.com)', 'ann@example.org'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Lager (lager.example.com):ann@example.org');
    expect(Object.fromEntries(uri.searchParams)).toEqual({ secret: 'ABCD', issuer: 'Lager (lager.example.com)', algorithm: 'SHA1', digits: '6', period: '30' });
  });
});

describe('setting up two-step sign-in', () => {
  it('is off until a code from the new secret confirms it, then hands out ten recovery codes once', () => {
    const { tf, userId } = setup();
    expect(tf.status(userId)).toEqual({ enabled: false, confirmedAt: null, recoveryLeft: 0, unreadable: false });
    const secret = tf.startSetup(userId, T0);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(tf.isEnabled(userId)).toBe(false);
    expect(tf.pendingSecret(userId, T0)).toBe(secret);
    expect(() => tf.confirmSetup(userId, '000000', T0)).toThrow(expect.objectContaining({ reason: 'two_factor_code_wrong' }));
    expect(tf.isEnabled(userId)).toBe(false);
    const codes = tf.confirmSetup(userId, codeAt(secret, T0), T0);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(tf.status(userId)).toMatchObject({ enabled: true, recoveryLeft: RECOVERY_CODE_COUNT, unreadable: false });
    // The secret is not handed out again once it is in force.
    expect(tf.pendingSecret(userId, T0)).toBeNull();
    expect(() => tf.startSetup(userId, T0)).toThrow(expect.objectContaining({ reason: 'two_factor_on' }));
  });

  it('names the pending setup with a mark that changes when it is started again and is gone once confirmed', () => {
    const { tf, userId } = setup();
    expect(tf.pendingMark(userId, T0)).toBeNull();
    const secret = tf.startSetup(userId, T0);
    const first = tf.pendingMark(userId, T0);
    expect(first).toMatch(/^[\w-]{22}$/);
    expect(first).not.toContain(secret);
    tf.startSetup(userId, T0);
    const second = tf.pendingMark(userId, T0);
    expect(second).not.toBe(first);
    expect(tf.pendingMark(userId, T0 + SETUP_TTL_MS)).toBeNull();
    tf.confirmSetup(userId, codeAt(tf.pendingSecret(userId, T0)!, T0), T0);
    expect(tf.pendingMark(userId, T0)).toBeNull();
  });

  it('a setup that was not confirmed in time is worthless', () => {
    const { tf, userId } = setup();
    const secret = tf.startSetup(userId, T0);
    const later = T0 + SETUP_TTL_MS;
    expect(tf.pendingSecret(userId, later)).toBeNull();
    expect(() => tf.confirmSetup(userId, codeAt(secret, later), later)).toThrow(expect.objectContaining({ reason: 'two_factor_setup_expired' }));
    expect(tf.isEnabled(userId)).toBe(false);
  });

  it('starting again replaces the secret that was shown before', () => {
    const { tf, userId } = setup();
    const first = tf.startSetup(userId, T0);
    const second = tf.startSetup(userId, T0);
    expect(second).not.toBe(first);
    expect(() => tf.confirmSetup(userId, codeAt(first, T0), T0)).toThrow();
    expect(tf.confirmSetup(userId, codeAt(second, T0), T0)).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it('stores neither the secret nor the recovery codes in the clear', () => {
    const { db, tf, userId } = setup();
    const { secret, codes } = enable(tf, userId, T0);
    const dump = JSON.stringify([db.prepare('SELECT * FROM user_two_factor').all(), db.prepare('SELECT * FROM user_recovery_codes').all()]);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(base32Decode(secret)!.toString('hex'));
    for (const c of codes) {
      expect(dump).not.toContain(c);
      expect(dump).not.toContain(c.replace(/-/g, ''));
    }
  });
});

describe('checking a code', () => {
  it('accepts the current code and its neighbours, each time step only once', () => {
    const { tf, userId } = setup();
    const { secret } = enable(tf, userId, T0);
    const now = T0 + 10 * 30_000;
    expect(tf.check(userId, codeAt(secret, now, -1), now)).toMatchObject({ ok: true, method: 'totp' });
    // The same code again, an older one, and one from outside the window are all refused.
    expect(tf.check(userId, codeAt(secret, now, -1), now)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.check(userId, codeAt(secret, now, -2), now)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.check(userId, codeAt(secret, now, 2), now)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.check(userId, codeAt(secret, now, 1), now)).toMatchObject({ ok: true });
    // Once the newest step of the window is used, nothing in the window is left.
    expect(tf.check(userId, codeAt(secret, now), now)).toEqual({ ok: false, reason: 'wrong' });
  });

  it('refuses the code that confirmed the setup', () => {
    const { tf, userId } = setup();
    const { secret } = enable(tf, userId, T0);
    expect(tf.check(userId, codeAt(secret, T0), T0)).toEqual({ ok: false, reason: 'wrong' });
  });

  it('takes spaces in a code and ignores anything that is not a code', () => {
    const { tf, userId } = setup();
    const { secret } = enable(tf, userId, T0);
    const now = T0 + 60_000;
    const code = codeAt(secret, now);
    for (const junk of ['', '12345', '1234567', 'abcdef', 'x'.repeat(1000), code + '0']) expect(tf.check(userId, junk, now).ok).toBe(false);
    // Clear the failures that junk caused before the real check would be paused.
    tf.disable(userId);
    const again = enable(tf, userId, now);
    const later = now + 60_000;
    const c2 = codeAt(again.secret, later);
    expect(tf.check(userId, `${c2.slice(0, 3)} ${c2.slice(3)}`, later)).toMatchObject({ ok: true, method: 'totp' });
  });

  it('a recovery code works once, in any case and with or without dashes', () => {
    const { tf, userId } = setup();
    const { codes } = enable(tf, userId, T0);
    expect(tf.check(userId, codes[0].toLowerCase().replace(/-/g, ' '), T0)).toEqual({ ok: true, method: 'recovery', recoveryLeft: RECOVERY_CODE_COUNT - 1 });
    expect(tf.check(userId, codes[0], T0)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.check(userId, codes[1], T0)).toMatchObject({ ok: true, recoveryLeft: RECOVERY_CODE_COUNT - 2 });
  });

  it('new recovery codes replace the old ones', () => {
    const { tf, userId } = setup();
    const { codes } = enable(tf, userId, T0);
    const fresh = tf.regenerateRecoveryCodes(userId);
    expect(fresh.some((c) => codes.includes(c))).toBe(false);
    expect(tf.check(userId, codes[0], T0)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.check(userId, fresh[0], T0)).toMatchObject({ ok: true, method: 'recovery' });
  });

  it('a recovery code of one account does not open another', () => {
    const { tf, users, userId } = setup();
    const other = users.create({ email: 'bob@example.org', name: 'Bob', password: 'password-123', role: 'user' }).id;
    const { codes } = enable(tf, userId, T0);
    enable(tf, other, T0);
    expect(tf.check(other, codes[0], T0)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.check(userId, codes[0], T0)).toMatchObject({ ok: true });
  });

  it('a secret copied into another account in the database opens nothing', () => {
    const { db, tf, users, userId } = setup();
    const victim = users.create({ email: 'bob@example.org', name: 'Bob', password: 'password-123', role: 'user' }).id;
    const mine = enable(tf, userId, T0);
    enable(tf, victim, T0);
    const stolen = (db.prepare('SELECT secret_enc FROM user_two_factor WHERE user_id = ?').get(userId) as { secret_enc: string }).secret_enc;
    db.prepare('UPDATE user_two_factor SET secret_enc = ? WHERE user_id = ?').run(stolen, victim);
    const now = T0 + 60_000;
    expect(tf.check(victim, codeAt(mine.secret, now), now)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.status(victim).unreadable).toBe(true);
  });

  it('refuses a secret whose authentication tag was cut short', () => {
    const { db, tf, userId } = setup();
    enable(tf, userId, T0);
    const [v, iv, tag, ct] = (db.prepare('SELECT secret_enc FROM user_two_factor').get() as { secret_enc: string }).secret_enc.split(':');
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    db.prepare('UPDATE user_two_factor SET secret_enc = ?').run([v, iv, short, ct].join(':'));
    expect(tf.status(userId).unreadable).toBe(true);
  });

  it('after the server secret changed only recovery codes work', () => {
    const { db, tf, userId } = setup('first-secret');
    const { secret, codes } = enable(tf, userId, T0);
    const replaced = new TwoFactor(db, 'second-secret');
    expect(replaced.status(userId)).toMatchObject({ enabled: true, unreadable: true });
    const now = T0 + 60_000;
    expect(replaced.check(userId, codeAt(secret, now), now)).toEqual({ ok: false, reason: 'wrong' });
    // Recovery codes are keyed with the server secret too: they need the old one.
    expect(replaced.check(userId, codes[0], now).ok).toBe(false);
    expect(tf.check(userId, codes[0], now)).toMatchObject({ ok: true, method: 'recovery' });
  });

  it('pauses the account after five wrong codes, ever longer, and counts nothing while paused', () => {
    const { tf, userId } = setup();
    const { secret } = enable(tf, userId, T0);
    let now = T0 + 60_000;
    for (let i = 1; i < MAX_CODE_FAILURES; i++) expect(tf.check(userId, '000000', now)).toEqual({ ok: false, reason: 'wrong' });
    expect(tf.check(userId, '000000', now)).toEqual({ ok: false, reason: 'locked', until: now + CODE_LOCK_STEPS_MS[0], started: true });
    // Even the right code is not looked at during the pause, and nothing is counted.
    expect(tf.check(userId, codeAt(secret, now), now)).toEqual({ ok: false, reason: 'locked', until: now + CODE_LOCK_STEPS_MS[0], started: false });
    for (let level = 1; level < CODE_LOCK_STEPS_MS.length + 2; level++) {
      now += CODE_LOCK_STEPS_MS[Math.min(level - 1, CODE_LOCK_STEPS_MS.length - 1)];
      for (let i = 1; i < MAX_CODE_FAILURES; i++) tf.check(userId, '000000', now);
      const step = CODE_LOCK_STEPS_MS[Math.min(level, CODE_LOCK_STEPS_MS.length - 1)];
      expect(tf.check(userId, '000000', now)).toEqual({ ok: false, reason: 'locked', until: now + step, started: true });
    }
    // Never longer than a day.
    expect(CODE_LOCK_STEPS_MS[CODE_LOCK_STEPS_MS.length - 1]).toBe(24 * 3600_000);
  });

  it('a right code ends the run of wrong codes but not the length of the next pause; each quiet day takes one step back', () => {
    const { tf, userId } = setup();
    const { secret } = enable(tf, userId, T0);
    let now = T0 + 60_000;
    const lockNow = (): ReturnType<TwoFactor['check']> => {
      for (let i = 1; i < MAX_CODE_FAILURES; i++) expect(tf.check(userId, '000000', now)).toEqual({ ok: false, reason: 'wrong' });
      return tf.check(userId, '000000', now);
    };
    expect(lockNow()).toMatchObject({ reason: 'locked', until: now + CODE_LOCK_STEPS_MS[0] });
    now += CODE_LOCK_STEPS_MS[0];
    expect(lockNow()).toMatchObject({ reason: 'locked', until: now + CODE_LOCK_STEPS_MS[1] });
    now += CODE_LOCK_STEPS_MS[1];
    expect(lockNow()).toMatchObject({ reason: 'locked', until: now + CODE_LOCK_STEPS_MS[2] });
    now += CODE_LOCK_STEPS_MS[2];
    // The owner signs in: the run ends, so four wrong codes do not pause; but the fifth starts the long pause, not the shortest.
    expect(tf.check(userId, codeAt(secret, now), now)).toMatchObject({ ok: true });
    expect(lockNow()).toMatchObject({ reason: 'locked', until: now + CODE_LOCK_STEPS_MS[3] });
    // Two quiet days after the end of that pause take it back two steps, not to the first.
    now += CODE_LOCK_STEPS_MS[3] + 2 * 24 * 3600_000;
    expect(lockNow()).toMatchObject({ reason: 'locked', until: now + CODE_LOCK_STEPS_MS[2] });
  });

  it('whatever the rhythm, an attacker who knows the password gets about five codes a day looked at', () => {
    const DAY = 24 * 3600_000;
    const YEAR = 365 * DAY;
    let worst = 0;
    // Spend a number of pauses, then wait a number of days, and repeat for a year; also guess the moment every pause ends.
    // The strongest rhythms against a reset to the first step were four or five pauses and then a quiet day.
    for (const batches of [1, 4, 5, 7]) {
      for (const waitDays of [0, 1, 3]) {
        const { tf, userId } = setup();
        enable(tf, userId, T0);
        let now = T0 + 60_000;
        let looked = 0;
        while (now < T0 + YEAR) {
          for (let b = 0; b < batches && now < T0 + YEAR; b++) {
            let r = tf.check(userId, '000000', now);
            while (r.ok === false && r.reason === 'locked' && !r.started) { now = r.until; r = tf.check(userId, '000000', now); }
            looked++;
            while (!(r.ok === false && r.reason === 'locked')) { r = tf.check(userId, '000000', now); looked++; }
            now = r.until;
          }
          now += waitDays * DAY;
        }
        worst = Math.max(worst, looked / 365);
      }
    }
    expect(worst).toBeLessThan(MAX_CODE_FAILURES + 1);
  }, 60_000);

  it('the count of wrong codes is kept in the database, across a restart', () => {
    const { db, tf, userId } = setup();
    enable(tf, userId, T0);
    const now = T0 + 60_000;
    for (let i = 1; i < MAX_CODE_FAILURES; i++) tf.check(userId, '000000', now);
    expect(new TwoFactor(db, 'server-secret').check(userId, '000000', now)).toMatchObject({ reason: 'locked', started: true });
  });

  it('an account without two-step sign-in, or with a setup that is not confirmed, accepts no code', () => {
    const { tf, userId } = setup();
    expect(tf.check(userId, '123456', T0)).toEqual({ ok: false, reason: 'wrong' });
    const secret = tf.startSetup(userId, T0);
    expect(tf.check(userId, codeAt(secret, T0), T0)).toEqual({ ok: false, reason: 'wrong' });
  });
});

describe('turning it off', () => {
  it('forgets the secret and the recovery codes', () => {
    const { db, tf, userId } = setup();
    enable(tf, userId, T0);
    expect(tf.disable(userId)).toBe(true);
    expect(tf.status(userId)).toEqual({ enabled: false, confirmedAt: null, recoveryLeft: 0, unreadable: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes').get()).toMatchObject({ n: 0 });
    expect(tf.disable(userId)).toBe(false);
  });

  it('goes with the account', () => {
    const { db, tf, userId } = setup();
    enable(tf, userId, T0);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_two_factor').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes').get()).toMatchObject({ n: 0 });
  });
});
