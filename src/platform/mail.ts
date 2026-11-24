import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { Config } from '../config.js';
import { LagerError } from '../errors.js';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { readonly enabled: boolean; send(mail: Mail): Promise<void> }

/**
 * Registering and inviting wait for the mail inside the request. Nodemailer would wait two minutes for a connection and ten
 * for a silent server; a mail server that does not answer within this time is treated as down.
 */
export const SMTP_TIMEOUT_MS = 10_000;

/** How the connection to the mail server is protected: TLS from the first byte (465), STARTTLS required (587), or nothing required. */
export type SmtpSecurity = 'tls' | 'starttls' | 'none';
export const SMTP_SECURITY: readonly SmtpSecurity[] = ['tls', 'starttls', 'none'];
const DEFAULT_PORTS: Record<SmtpSecurity, number> = { tls: 465, starttls: 587, none: 25 };

/** The mail server an administrator entered in the administration area. The password is never part of it. */
export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Empty when the server takes mail without signing in. */
  user: string;
  /** Empty = the sender from LAGER_MAIL_FROM, or `Lager <no-reply@<platform host>>`. */
  from: string;
  passwordSaved: boolean;
  /** A password is stored but no longer decrypts, because LAGER_SECRET changed since it was saved: it has to be entered again. */
  passwordUnreadable: boolean;
}

export interface SmtpInput {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  /** `undefined` keeps the stored password; an empty string removes it. */
  password?: string;
  from: string;
}

export const MAX_SMTP_PASSWORD = 500;
const MAX_SMTP_USER = 254;
const MAX_FROM = 200;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV6_RE = /^\[?[0-9a-f:.]+\]?$/i;
/** A bare address, or `Name <address>`; nothing that could end a mail header. */
const FROM_RE = /^(?:[^<>@\p{Cc}]*<[^<>@\s\p{Cc}]+@[^<>@\s\p{Cc}]+>|[^<>@\s\p{Cc}]+@[^<>@\s\p{Cc}]+)$/u;
const KEY_PREFIX = 'smtp_';

const bad = (message: string): never => { throw new LagerError('invalid_argument', message); };

/**
 * The mail server set in the administration area, in the `settings` table. The password is encrypted with a key derived from
 * LAGER_SECRET, like stored AI provider keys, and leaves this class only towards the mail server.
 */
export class MailSettings {
  private keyBytes: Buffer;
  /** Goes up with every change, so a mailer knows when to build its connection again. */
  version = 0;

  constructor(private db: DatabaseSync, secret: string) {
    // A key of its own, so the stored password cannot be read with the session-signing or AI key and the other way round.
    this.keyBytes = crypto.createHash('sha256').update(`lager-smtp-password:${secret}`).digest();
  }

  private read(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY_PREFIX + key) as { value: string } | undefined)?.value;
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keyBytes, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  private decrypt(stored: string | undefined): string | null {
    if (!stored) return null;
    const [v, iv, tag, ct] = stored.split(':');
    if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.keyBytes, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Null until an administrator saved a mail server. */
  get(): SmtpSettings | null {
    const host = this.read('host');
    if (!host) return null;
    const security = SMTP_SECURITY.includes(this.read('security') as SmtpSecurity) ? this.read('security') as SmtpSecurity : 'starttls';
    const port = Number(this.read('port'));
    const enc = this.read('password_enc');
    return {
      host, security,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORTS[security],
      user: this.read('user') ?? '',
      from: this.read('from') ?? '',
      passwordSaved: Boolean(enc),
      passwordUnreadable: Boolean(enc) && this.decrypt(enc) === null,
    };
  }

  /** What nodemailer needs to connect; null without a stored server. */
  transportOptions(timeoutMs: number): { options: SMTPTransport.Options; from: string } | null {
    const s = this.get();
    if (!s) return null;
    const pass = this.decrypt(this.read('password_enc')) ?? '';
    return {
      from: s.from,
      options: {
        host: s.host.replace(/^\[|\]$/g, ''), port: s.port,
        secure: s.security === 'tls',
        // "none" still upgrades when the server offers STARTTLS; it only does not insist on it.
        requireTLS: s.security === 'starttls',
        ...(s.user ? { auth: { user: s.user, pass } } : {}),
        connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
      },
    };
  }

  save(input: SmtpInput): void {
    const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
    if (!host || !(HOST_RE.test(host) || (host.includes(':') && IPV6_RE.test(host)))) bad('The mail server must be a host name such as smtp.example.com.');
    if (!SMTP_SECURITY.includes(input.security)) bad('Encryption must be tls, starttls or none.');
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) bad('The port must be a whole number from 1 to 65535.');
    const user = typeof input.user === 'string' ? input.user.trim() : '';
    if (user.length > MAX_SMTP_USER || /\p{Cc}/u.test(user)) bad(`The user name may have at most ${MAX_SMTP_USER} characters.`);
    const from = typeof input.from === 'string' ? input.from.trim() : '';
    if (from && (from.length > MAX_FROM || !FROM_RE.test(from))) bad('The sender must be an address such as lager@example.com or "Lager <lager@example.com>".');
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > MAX_SMTP_PASSWORD)) {
      bad(`The password may have at most ${MAX_SMTP_PASSWORD} characters.`);
    }
    const write = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      write.run(`${KEY_PREFIX}host`, host);
      write.run(`${KEY_PREFIX}port`, String(input.port));
      write.run(`${KEY_PREFIX}security`, input.security);
      write.run(`${KEY_PREFIX}user`, user);
      write.run(`${KEY_PREFIX}from`, from);
      // Without a user name there is nothing to sign in with, so a password left behind would only be a secret kept for nothing.
      if (!user || input.password === '') remove.run(`${KEY_PREFIX}password_enc`);
      else if (input.password !== undefined) write.run(`${KEY_PREFIX}password_enc`, this.encrypt(input.password));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.version++;
  }

  /** Forgets the mail server and its password; mail is off again unless LAGER_SMTP_URL is set. */
  clear(): void {
    this.db.prepare(`DELETE FROM settings WHERE key LIKE '${KEY_PREFIX}%'`).run();
    this.version++;
  }
}

/** The sender when the administration area names none: LAGER_MAIL_FROM, else `Lager <no-reply@<platform host>>`. */
export const defaultSender = (config: Config): string => config.mailFrom ?? `Lager <no-reply@${config.publicUrl.hostname}>`;

/** Where the mail server comes from: LAGER_SMTP_URL wins over the administration area, so a configuration in files stays in charge. */
export type MailSource = 'env' | 'admin' | 'none';

export interface ConfigurableMailer extends Mailer {
  readonly source: MailSource;
}

/**
 * SMTP mailer from `smtpUrl` when it is configured, else from the mail server saved in the administration area; with neither,
 * `enabled` is false and `send` does nothing. No connection is opened until `send`, and a change in the administration area
 * applies to the next mail without a restart.
 */
export function createMailer(config: Config, timeoutMs = SMTP_TIMEOUT_MS, stored?: MailSettings): ConfigurableMailer {
  const defaultFrom = defaultSender(config);
  if (config.smtpUrl) {
    const transport = nodemailer.createTransport({ url: config.smtpUrl, connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs });
    return {
      enabled: true, source: 'env',
      async send(mail) {
        await transport.sendMail({ from: defaultFrom, to: mail.to, subject: mail.subject, text: mail.text });
      },
    };
  }
  let built: { version: number; transport: Transporter; from: string } | null = null;
  return {
    get enabled() { return stored?.get() != null; },
    get source(): MailSource { return stored?.get() ? 'admin' : 'none'; },
    async send(mail) {
      if (!stored) return;
      if (!built || built.version !== stored.version) {
        built?.transport.close();
        const opts = stored.transportOptions(timeoutMs);
        built = opts ? { version: stored.version, transport: nodemailer.createTransport(opts.options), from: opts.from || defaultFrom } : null;
      }
      if (!built) return;
      await built.transport.sendMail({ from: built.from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

/**
 * An address as the log shows it: the first character of the local part and the domain (`j***@example.com`). Enough to tell
 * which mail failed when you know who was writing, without the log becoming a list of everyone's addresses.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${Array.from(address)[0]}***${address.slice(at)}`;
}

/** Collects mail in memory; for tests. */
export class MemoryMailer implements Mailer {
  enabled = true;
  sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}
