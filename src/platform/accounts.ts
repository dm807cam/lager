import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { LagerError } from '../errors.js';
import { t, type Locale, type MessageKey } from '../i18n/index.js';
import { maskAddress, type Mailer } from './mail.js';
import type { Settings } from './settings.js';
import { hashSecret, sameHash } from './tokens.js';
import { hashPassword, MAX_NAME_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type Role, type User, type Users } from './users.js';

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

/** Why an account's owner hears about its two-step sign-in. */
export type TwoFactorNotice = 'enabled' | 'disabled' | 'reset' | 'recovery' | 'renewed' | 'locked';
const TWO_FACTOR_MAIL_KEYS: Record<TwoFactorNotice, { subject: MessageKey; text: MessageKey }> = {
  enabled: { subject: 'mail.twoFactor.enabled.subject', text: 'mail.twoFactor.enabled.text' },
  disabled: { subject: 'mail.twoFactor.disabled.subject', text: 'mail.twoFactor.disabled.text' },
  reset: { subject: 'mail.twoFactor.reset.subject', text: 'mail.twoFactor.reset.text' },
  recovery: { subject: 'mail.twoFactor.recovery.subject', text: 'mail.twoFactor.recovery.text' },
  renewed: { subject: 'mail.twoFactor.renewed.subject', text: 'mail.twoFactor.renewed.text' },
  locked: { subject: 'mail.twoFactor.locked.subject', text: 'mail.twoFactor.locked.text' },
};
/**
 * Verification, reset and "already registered" mails the whole server sends per hour: anyone can cause them, and they leave from the
 * operator's mail account. Invitations are an administrator's own act and do not count.
 */
export const MAX_ACCOUNT_MAILS_PER_HOUR = 60;
/** Password-reset mails have an hourly budget of their own: registering must not be a way to use up the mails that let an owner back in. */
export const MAX_RESET_MAILS_PER_HOUR = 60;
type Budget = 'account' | 'reset';
const BUDGETS: Record<Budget, number> = { account: MAX_ACCOUNT_MAILS_PER_HOUR, reset: MAX_RESET_MAILS_PER_HOUR };
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
  private mailTimes: Record<Budget, number[]> = { account: [], reset: [] };
  /** Links and invitations a request is working on right now, by token hash; see `once`. */
  private inFlight = new Set<string>();

  constructor(
    private db: DatabaseSync, private users: Users, private settings: Settings,
    private mailer: Mailer, private config: Config,
  ) {}

  /**
   * Runs `work` for a link or invitation unless another request is already working on the same one. A token is used up only
   * after its password has been hashed, so without this, one link posted many times at once would be hashed as many times, in
   * the lane that goes ahead of every sign-in. The others are told to try again; by then the first has usually used the token up.
   */
  private async once<T>(row: TokenRow, work: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(row.hash)) throw new LagerError('rate_limited', 'This link is being processed. Please try again in a moment.', 'busy');
    this.inFlight.add(row.hash);
    try {
      return await work();
    } finally {
      this.inFlight.delete(row.hash);
    }
  }

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
  private async deliver(to: string, locale: Locale | null | undefined, url: string, kind: Kind, beyondBudget = false): Promise<void> {
    const lang = locale ?? this.config.defaultLocale;
    const keys = MAIL_KEYS[kind];
    await this.send(to, t(lang, keys.subject), `${t(lang, keys.intro)}\n\n${url}\n\n${t(lang, keys.validity)}\n`, kind === 'invite' || beyondBudget ? null : kind === 'reset' ? 'reset' : 'account');
  }

  /** A mail that counts against a budget is dropped once that budget is spent; callers that can tell the visitor check `mailBudgetSpent` first. */
  private async send(to: string, subject: string, text: string, budget: Budget | null): Promise<void> {
    if (budget && !this.mailBudget(budget, true)) {
      console.warn(`Mail to ${maskAddress(to)} was not sent: more than ${BUDGETS[budget]} ${budget} mails in an hour.`);
      return;
    }
    try {
      await this.mailer.send({ to, subject, text });
    } catch (e) {
      // The log names the recipient only in masked form, also where the mail server's answer repeats the address.
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`Could not send mail to ${maskAddress(to)}: ${reason.split(to).join(maskAddress(to))}`);
    }
  }

  private mailBudget(budget: Budget, spend: boolean): boolean {
    const cutoff = Date.now() - HOUR_MS;
    const times = this.mailTimes[budget] = this.mailTimes[budget].filter((sent) => sent > cutoff);
    if (times.length >= BUDGETS[budget]) return false;
    if (spend) times.push(Date.now());
    return true;
  }

  /** True while the server has sent this hour's mails of that kind: a flow that needs one should not start. */
  mailBudgetSpent(budget: Budget): boolean { return !this.mailBudget(budget, false); }

  /** For mail that is started and not awaited: whatever goes wrong is logged, never left as an unhandled rejection that ends the process. */
  private background(mail: Promise<void>): void {
    mail.catch((e: unknown) => { console.error('Could not send mail:', e); });
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
    // Where a taken address is named to the visitor anyway (no mail, or an invitation sent to that address), it is refused before
    // any hashing: such attempts are not held by the hourly cap and must not cost a hash each.
    if (verified && this.users.getByEmail(email)) throw new LagerError('conflict', `A user with email ${email} already exists.`, 'email_taken');
    const create = async (): Promise<User> => {
      // Hashed before the transaction, and before it is known whether the address is taken: both outcomes take the same time.
      const passwordHash = await hashPassword(input.password);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (invite && !this.consume(invite)) throw new LagerError('forbidden', 'The invitation is invalid or has expired.', 'invite_invalid');
        const created = this.users.create({ email, name, password: input.password, passwordHash, role: invite?.role ?? 'user', verified, locale: input.locale });
        this.db.exec('COMMIT');
        return created;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
    const user = invite ? await this.once(invite, create) : await create();
    // Started but not awaited, like the notice to an address that is taken: how long the mail server takes says nothing to the visitor.
    if (!verified) this.background(this.sendVerification(user, input.locale));
    return { user, needsVerification: !verified };
  }

  /**
   * Tells the owner of an account that someone tried to register with its address, and how to get in. The registration page
   * answers as if a new account had been created, so it does not reveal which addresses have one.
   */
  noticeExistingAccount(email: string, requestLocale?: Locale): void {
    const user = this.users.getByEmail(email);
    if (!user) return;
    const lang = user.locale ?? requestLocale ?? this.config.defaultLocale;
    const { origin } = this.config.publicUrl;
    const text = `${t(lang, 'mail.exists.intro')}\n\n${origin}/login\n\n${t(lang, 'mail.exists.reset')}\n\n${origin}/forgot\n\n${t(lang, 'mail.exists.ignore')}\n`;
    this.background(this.send(user.email, t(lang, 'mail.exists.subject'), text, 'account'));
  }

  /**
   * Tells the owner of an account about a change to its two-step sign-in, or about a sign-in that got past the password but not
   * the code. Never held back by a mail budget: each of these needs the account's password, a session or an administrator, so
   * nobody can send them in bulk, and they are how the owner learns that their password is known to someone else.
   */
  noticeTwoFactor(user: User, kind: TwoFactorNotice, requestLocale?: Locale, recoveryLeft = 0): void {
    const lang = user.locale ?? requestLocale ?? this.config.defaultLocale;
    const keys = TWO_FACTOR_MAIL_KEYS[kind];
    const text = `${t(lang, keys.text, { count: recoveryLeft })}\n\n${t(lang, 'mail.twoFactor.notYou')}\n\n${this.config.publicUrl.origin}/forgot\n`;
    this.background(this.send(user.email, t(lang, keys.subject), text, null));
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
  async verifyEmail(token: string, password: string): Promise<User> {
    const row = this.find('verify', token);
    const user = row?.user_id ? this.users.get(row.user_id) : null;
    if (!row || !user) throw invalidToken();
    // Ahead of ordinary sign-ins: the caller holds the link, and one link is checked by one request at a time.
    const login = await this.once(row, () => this.users.checkLogin(user.email, typeof password === 'string' ? password : '', true));
    if (!login.ok && login.reason === 'invalid') throw new LagerError('forbidden', 'The password is wrong.', 'password_wrong');
    if ((!login.ok && login.reason === 'disabled') || !this.consume(row)) throw invalidToken();
    this.users.markVerified(user.id);
    return this.users.get(user.id)!;
  }

  async resendVerification(email: string, locale?: Locale): Promise<void> {
    const user = typeof email === 'string' ? this.users.getByEmail(email) : null;
    // Delivery is started but not awaited, so response time does not reveal whether the address exists.
    if (user && !user.verified) this.background(this.sendVerification(user, locale));
  }

  /** `beyondBudget` sends the mail even when this hour's reset mails are spent: for an account that is paused, whose owner has no other way in. */
  async requestPasswordReset(email: string, locale?: Locale, beyondBudget = false): Promise<void> {
    const user = typeof email === 'string' ? this.users.getByEmail(email) : null;
    if (!user) return;
    const { token } = this.issue('reset', { userId: user.id });
    // Started but not awaited (see resendVerification); `deliver` catches send errors, so nothing is left unhandled.
    this.background(this.deliver(user.email, user.locale ?? locale, this.link('/reset', 'token', token), 'reset', beyondBudget));
  }

  createResetLink(userId: string): string {
    if (!this.users.get(userId)) throw new LagerError('not_found', 'User not found.');
    return this.link('/reset', 'token', this.issue('reset', { userId }).token);
  }

  async resetPassword(token: string, password: string): Promise<User> {
    const row = this.find('reset', token);
    if (!row?.user_id || !this.users.get(row.user_id)) throw invalidToken();
    assertPassword(password);
    const userId = row.user_id;
    return this.once(row, async () => {
      // Hashed before the link is used up: if the server is too busy to hash, the link still works afterwards.
      const passwordHash = await hashPassword(password);
      // One step: a link that is used up has set the password. If setting it fails, the link works again.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!this.consume(row)) throw invalidToken();
        this.users.setPasswordHashed(userId, password, passwordHash);
        this.deleteResetLinks(userId);
        this.users.markVerified(userId);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      return this.users.get(userId)!;
    });
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
