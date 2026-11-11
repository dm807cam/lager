import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { LagerError } from '../errors.js';
import type { Mailer } from './mail.js';
import type { Settings } from './settings.js';
import { hashSecret, sameHash } from './tokens.js';
import { MIN_PASSWORD_LENGTH, type Role, type User, type Users } from './users.js';

export interface InviteInfo { id: string; email: string | null; role: Role; createdAt: string; expiresAt: string; used: boolean }

type Kind = 'verify' | 'reset' | 'invite';
interface TokenRow {
  hash: string; id: string; kind: Kind; user_id: string | null; email: string | null; role: Role | null;
  created_by: string | null; created_at: string; expires_at: string; used_at: string | null;
}

const HOUR_MS = 3600_000;
const TTL_MS: Record<Kind, number> = { verify: 24 * HOUR_MS, reset: HOUR_MS, invite: 7 * 24 * HOUR_MS };
const VALIDITY: Record<Kind, string> = { verify: '24 Stunden', reset: 'einer Stunde', invite: '7 Tage' };
const ROLES: readonly Role[] = ['admin', 'publisher', 'user'];
const MAX_NAME = 80;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

const invalidToken = (): LagerError => new LagerError('invalid_argument', 'Der Link ist ungültig oder abgelaufen.');

const toInvite = (r: TokenRow): InviteInfo => ({
  id: r.id, email: r.email, role: r.role ?? 'user', createdAt: r.created_at, expiresAt: r.expires_at, used: r.used_at !== null,
});

/** Registration, e-mail verification, password reset and invitations. One-time tokens are stored as SHA-256 only. */
export class Accounts {
  private resetHooks: Array<(userId: string) => void> = [];

  constructor(
    private db: DatabaseSync, private users: Users, private settings: Settings,
    private mailer: Mailer, private config: Config,
  ) {}

  /** Runs after a password was set through a reset link (recovery), as opposed to a change by the signed-in owner. */
  onPasswordReset(hook: (userId: string) => void): void { this.resetHooks.push(hook); }

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

  /** Mail problems are logged, never surfaced: they must not reveal whether an address exists or undo the action. */
  private async deliver(to: string, subject: string, intro: string, url: string, kind: Kind): Promise<void> {
    const text = `${intro}\n\n${url}\n\nDieser Link ist ${VALIDITY[kind]} gültig und kann nur einmal verwendet werden.\n`;
    try {
      await this.mailer.send({ to, subject, text });
    } catch (e) {
      console.error(`Could not send mail to ${to}:`, e);
    }
  }

  private async sendVerification(user: User): Promise<void> {
    const { token } = this.issue('verify', { userId: user.id });
    await this.deliver(user.email, 'Lager: E-Mail-Adresse bestätigen',
      'Willkommen bei Lager. Bitte bestätige deine E-Mail-Adresse über den folgenden Link. Wenn du dich nicht bei Lager registriert hast, ignoriere diese E-Mail.',
      this.link('/verify', 'token', token), 'verify');
  }

  async register(input: { name: string; email: string; password: string; inviteToken?: string }): Promise<{ user: User; needsVerification: boolean }> {
    const mode = this.settings.registration;
    if (mode === 'closed') throw new LagerError('forbidden', 'Die Registrierung ist geschlossen.');
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';

    let invite: TokenRow | null = null;
    if (input.inviteToken) {
      invite = this.find('invite', input.inviteToken);
      if (!invite) throw new LagerError('forbidden', 'Die Einladung ist ungültig oder abgelaufen.');
      if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
        throw new LagerError('forbidden', 'Die Einladung gilt für eine andere E-Mail-Adresse.');
      }
    } else if (mode === 'invite') {
      throw new LagerError('forbidden', 'Die Registrierung ist nur mit Einladung möglich.');
    }

    if (!name || name.length > MAX_NAME) throw new LagerError('invalid_argument', `Der Name muss 1 bis ${MAX_NAME} Zeichen lang sein.`);
    if (!EMAIL_RE.test(email)) throw new LagerError('invalid_argument', 'Bitte gib eine gültige E-Mail-Adresse an.');
    if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new LagerError('invalid_argument', `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
    }

    const verified = invite !== null || !this.mailer.enabled;
    let user: User;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (invite && !this.consume(invite)) throw new LagerError('forbidden', 'Die Einladung ist ungültig oder abgelaufen.');
      user = this.users.create({ email, name, password: input.password, role: invite?.role ?? 'user', verified });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (!verified) await this.sendVerification(user);
    return { user, needsVerification: !verified };
  }

  /** True while the token is an unused, unexpired verification link; consumes nothing. */
  checkVerificationToken(token: string): boolean {
    const row = this.find('verify', token);
    return row !== null && row.user_id !== null && this.users.get(row.user_id) !== null;
  }

  verifyEmail(token: string): User {
    const row = this.find('verify', token);
    if (!row?.user_id || !this.users.get(row.user_id) || !this.consume(row)) throw invalidToken();
    this.users.markVerified(row.user_id);
    return this.users.get(row.user_id)!;
  }

  async resendVerification(email: string): Promise<void> {
    const user = typeof email === 'string' ? this.users.getByEmail(email) : null;
    // Delivery is started but not awaited, so response time does not reveal whether the address exists.
    if (user && !user.verified) void this.sendVerification(user);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = typeof email === 'string' ? this.users.getByEmail(email) : null;
    if (!user) return;
    const { token } = this.issue('reset', { userId: user.id });
    // Started but not awaited (see resendVerification); `deliver` catches send errors, so nothing is left unhandled.
    void this.deliver(user.email, 'Lager: Passwort zurücksetzen',
      'Für dein Konto wurde ein neues Passwort angefordert. Über den folgenden Link kannst du es festlegen. Wenn du das nicht warst, ignoriere diese Nachricht.',
      this.link('/reset', 'token', token), 'reset');
  }

  createResetLink(userId: string): string {
    if (!this.users.get(userId)) throw new LagerError('not_found', 'User not found.');
    return this.link('/reset', 'token', this.issue('reset', { userId }).token);
  }

  resetPassword(token: string, password: string): User {
    const row = this.find('reset', token);
    if (!row?.user_id || !this.users.get(row.user_id)) throw invalidToken();
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new LagerError('invalid_argument', `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
    }
    if (!this.consume(row)) throw invalidToken();
    this.users.setPassword(row.user_id, password);
    this.deleteResetLinks(row.user_id);
    this.users.markVerified(row.user_id);
    for (const hook of this.resetHooks) hook(row.user_id);
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

  async createInvite(input: { email?: string; role: Role; createdBy: string }): Promise<{ id: string; url: string }> {
    if (!ROLES.includes(input.role)) throw new LagerError('invalid_argument', `Unknown role "${String(input.role)}".`);
    const email = input.email?.trim() || undefined;
    if (email && !EMAIL_RE.test(email)) throw new LagerError('invalid_argument', 'Bitte gib eine gültige E-Mail-Adresse an.');
    const { token, id } = this.issue('invite', { email, role: input.role, createdBy: input.createdBy });
    const url = this.link('/register', 'invite', token);
    if (email) {
      await this.deliver(email, 'Lager: Einladung',
        'Du wurdest zu Lager eingeladen. Über den folgenden Link kannst du dein Konto anlegen.', url, 'invite');
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
