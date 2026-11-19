import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { LagerError } from '../errors.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import type { Mailer } from './mail.js';
import type { Settings } from './settings.js';
import { hashSecret, sameHash } from './tokens.js';
import { MAX_NAME_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type Role, type User, type Users } from './users.js';

export interface InviteInfo { id: string; email: string | null; role: Role; createdAt: string; expiresAt: string; used: boolean }

type Kind = 'verify' | 'reset' | 'invite';
interface TokenRow {
  hash: string; id: string; kind: Kind; user_id: string | null; email: string | null; role: Role | null;
  created_by: string | null; created_at: string; expires_at: string; used_at: string | null;
}

const HOUR_MS = 3600_000;
const TTL_MS: Record<Kind, number> = { verify: 24 * HOUR_MS, reset: HOUR_MS, invite: 7 * 24 * HOUR_MS };
const MAIL_KEYS: Record<Kind, { subject: MessageKey; intro: MessageKey; validity: MessageKey }> = {
  verify: { subject: 'mail.verify.subject', intro: 'mail.verify.intro', validity: 'mail.validity.verify' },
  reset: { subject: 'mail.reset.subject', intro: 'mail.reset.intro', validity: 'mail.validity.reset' },
  invite: { subject: 'mail.invite.subject', intro: 'mail.invite.intro', validity: 'mail.validity.invite' },
};
const ROLES: readonly Role[] = ['admin', 'publisher', 'user'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

const invalidToken = (): LagerError => new LagerError('invalid_argument', 'The link is invalid or has expired.', 'link_invalid');

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new LagerError('invalid_argument', `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`, 'password_short');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new LagerError('invalid_argument', `The password must be at most ${MAX_PASSWORD_LENGTH} characters long.`, 'password_long');
  }
}

const toInvite = (r: TokenRow): InviteInfo => ({
  id: r.id, email: r.email, role: r.role ?? 'user', createdAt: r.created_at, expiresAt: r.expires_at, used: r.used_at !== null,
});

/** Registration, e-mail verification, password reset and invitations. One-time tokens are stored as SHA-256 only. */
export class Accounts {
  constructor(
    private db: DatabaseSync, private users: Users, private settings: Settings,
    private mailer: Mailer, private config: Config,
  ) {}

  private link(path: string, param: string, token: string): string {
    return `${this.config.publicUrl.origin}${path}?${param}=${token}`;
  }

  private issue(kind: Kind, f: { userId?: string; email?: string; role?: Role; createdBy?: string }): { token: string; id: string } {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO account_tokens (hash, id, kind, user_id, email, role, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(hashSecret(token), id, kind, f.userId ?? null, f.email ?? null, f.role ?? null, f.createdBy ?? null,
        new Date(now).toISOString(), new Date(now + TTL_MS[kind]).toISOString());
    return { token, id };
  }

  /** The row of an unused, unexpired token of this kind, or null. */
  private find(kind: Kind, token: string): TokenRow | null {
    if (typeof token !== 'string' || token === '' || token.length > 200) return null;
    const hash = hashSecret(token);
    const row = this.db.prepare('SELECT * FROM account_tokens WHERE hash = ? AND kind = ?').get(hash, kind) as TokenRow | undefined;
    if (!row || !sameHash(row.hash, hash) || row.used_at !== null || Date.parse(row.expires_at) <= Date.now()) return null;
    return row;
  }

  /** Marks the row used; false if somebody else got there first. */
  private consume(row: TokenRow): boolean {
    return Number(this.db.prepare('UPDATE account_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL')
      .run(new Date().toISOString(), row.hash).changes) > 0;
  }

  /**
   * Mail is written in the recipient's language: the account's stored one, else the one of the request that caused the mail,
   * else the configured default. Mail problems are logged, never surfaced: they must not reveal whether an address exists or undo the action.
   */
  private async deliver(to: string, locale: Locale | null | undefined, url: string, kind: Kind): Promise<void> {
    const lang = locale ?? this.config.defaultLocale;
    const keys = MAIL_KEYS[kind];
    const text = `${t(lang, keys.intro)}\n\n${url}\n\n${t(lang, keys.validity)}\n`;
    try {
      await this.mailer.send({ to, subject: t(lang, keys.subject), text });
    } catch (e) {
      console.error(`Could not send mail to ${to}:`, e);
    }
  }

  private async sendVerification(user: User, requestLocale?: Locale): Promise<void> {
    const { token } = this.issue('verify', { userId: user.id });
    await this.deliver(user.email, user.locale ?? requestLocale, this.link('/verify', 'token', token), 'verify');
  }

  async register(input: { name: string; email: string; password: string; inviteToken?: string; locale?: Locale }): Promise<{ user: User; needsVerification: boolean }> {
    const mode = this.settings.registration;
    if (mode === 'closed') throw new LagerError('forbidden', 'Registration is closed.', 'registration_closed');
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';

    let invite: TokenRow | null = null;
    if (input.inviteToken) {
      invite = this.find('invite', input.inviteToken);
      if (!invite) throw new LagerError('forbidden', 'The invitation is invalid or has expired.', 'invite_invalid');
      if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
        throw new LagerError('forbidden', 'The invitation is for a different email address.', 'invite_email_mismatch');
      }
    } else if (mode === 'invite') {
      throw new LagerError('forbidden', 'Registration is by invitation only.', 'invite_required');
    }

    if (!name || name.length > MAX_NAME_LENGTH) throw new LagerError('invalid_argument', `The name must be 1 to ${MAX_NAME_LENGTH} characters long.`, 'name_invalid');
    if (!EMAIL_RE.test(email)) throw new LagerError('invalid_argument', 'Please enter a valid email address.', 'email_invalid');
    assertPassword(input.password);

    // An invitation proves a mailbox only when it was sent to exactly this address (checked above); an open one proves none.
    const verified = !this.mailer.enabled || Boolean(invite?.email);
    let user: User;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (invite && !this.consume(invite)) throw new LagerError('forbidden', 'The invitation is invalid or has expired.', 'invite_invalid');
      user = this.users.create({ email, name, password: input.password, role: invite?.role ?? 'user', verified, locale: input.locale });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (!verified) await this.sendVerification(user, input.locale);
    return { user, needsVerification: !verified };
  }

  /** True while the token is an unused, unexpired verification link; consumes nothing. */
  checkVerificationToken(token: string): boolean {
    const row = this.find('verify', token);
    return row !== null && row.user_id !== null && this.users.get(row.user_id) !== null;
  }

  /**
   * Confirms the address of whoever holds both the link and the account's password. The link alone is not enough: anyone can
   * register someone else's address, and the owner of the mailbox must not confirm an account whose password another person chose.
   * A wrong password leaves the link usable.
   */
  verifyEmail(token: string, password: string): User {
    const row = this.find('verify', token);
    const user = row?.user_id ? this.users.get(row.user_id) : null;
    if (!row || !user) throw invalidToken();
    const login = this.users.checkLogin(user.email, typeof password === 'string' ? password : '');
    if (!login.ok && login.reason === 'invalid') throw new LagerError('forbidden', 'The password is wrong.', 'password_wrong');
    if ((!login.ok && login.reason === 'disabled') || !this.consume(row)) throw invalidToken();
    this.users.markVerified(user.id);
    return this.users.get(user.id)!;
  }

  async resendVerification(email: string, locale?: Locale): Promise<void> {
    const user = typeof email === 'string' ? this.users.getByEmail(email) : null;
    // Delivery is started but not awaited, so response time does not reveal whether the address exists.
    if (user && !user.verified) void this.sendVerification(user, locale);
  }

  async requestPasswordReset(email: string, locale?: Locale): Promise<void> {
    const user = typeof email === 'string' ? this.users.getByEmail(email) : null;
    if (!user) return;
    const { token } = this.issue('reset', { userId: user.id });
    // Started but not awaited (see resendVerification); `deliver` catches send errors, so nothing is left unhandled.
    void this.deliver(user.email, user.locale ?? locale, this.link('/reset', 'token', token), 'reset');
  }

  createResetLink(userId: string): string {
    if (!this.users.get(userId)) throw new LagerError('not_found', 'User not found.');
    return this.link('/reset', 'token', this.issue('reset', { userId }).token);
  }

  resetPassword(token: string, password: string): User {
    const row = this.find('reset', token);
    if (!row?.user_id || !this.users.get(row.user_id)) throw invalidToken();
    assertPassword(password);
    if (!this.consume(row)) throw invalidToken();
    this.users.setPassword(row.user_id, password);
    this.deleteResetLinks(row.user_id);
    this.users.markVerified(row.user_id);
    return this.users.get(row.user_id)!;
  }

  /** Pending reset links of the account stop working. */
  deleteResetLinks(userId: string): void {
    this.db.prepare("DELETE FROM account_tokens WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL").run(userId);
  }

  /** Unused invitations created by this account stop working. */
  deleteInvitesBy(userId: string): void {
    this.db.prepare("DELETE FROM account_tokens WHERE kind = 'invite' AND created_by = ? AND used_at IS NULL").run(userId);
  }

  /** `locale` is the language of the invitation mail: the administrator's request language, since the invitee has no account yet. */
  async createInvite(input: { email?: string; role: Role; createdBy: string; locale?: Locale }): Promise<{ id: string; url: string }> {
    if (!ROLES.includes(input.role)) throw new LagerError('invalid_argument', `Unknown role "${String(input.role)}".`);
    const email = input.email?.trim() || undefined;
    if (email && !EMAIL_RE.test(email)) throw new LagerError('invalid_argument', 'Please enter a valid email address.', 'email_invalid');
    const { token, id } = this.issue('invite', { email, role: input.role, createdBy: input.createdBy });
    const url = this.link('/register', 'invite', token);
    if (email) {
      await this.deliver(email, input.locale, url, 'invite');
    }
    return { id, url };
  }

  getInvite(token: string): InviteInfo | null {
    const row = this.find('invite', token);
    return row ? toInvite(row) : null;
  }

  listInvites(): InviteInfo[] {
    const rows = this.db.prepare("SELECT * FROM account_tokens WHERE kind = 'invite' ORDER BY created_at DESC, rowid DESC").all() as unknown as TokenRow[];
    return rows.map(toInvite);
  }

  revokeInvite(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM account_tokens WHERE id = ? AND kind = 'invite' AND used_at IS NULL").run(id).changes) > 0;
  }
}
