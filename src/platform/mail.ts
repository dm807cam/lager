import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { readonly enabled: boolean; send(mail: Mail): Promise<void> }

/**
 * Registering and inviting wait for the mail inside the request. Nodemailer would wait two minutes for a connection and ten
 * for a silent server; a mail server that does not answer within this time is treated as down.
 */
export const SMTP_TIMEOUT_MS = 10_000;

/** SMTP mailer when `smtpUrl` is configured; otherwise a disabled one whose `send` does nothing. No connection is opened until `send`. */
export function createMailer(config: Config, timeoutMs = SMTP_TIMEOUT_MS): Mailer {
  if (!config.smtpUrl) return { enabled: false, async send() {} };
  const from = config.mailFrom ?? `Lager <no-reply@${config.publicUrl.hostname}>`;
  const transport = nodemailer.createTransport({ url: config.smtpUrl, connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs });
  return {
    enabled: true,
    async send(mail) {
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

/** Collects mail in memory; for tests. */
export class MemoryMailer implements Mailer {
  enabled = true;
  sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}
