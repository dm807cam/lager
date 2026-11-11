import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { readonly enabled: boolean; send(mail: Mail): Promise<void> }

/** SMTP mailer when `smtpUrl` is configured; otherwise a disabled one whose `send` does nothing. No connection is opened until `send`. */
export function createMailer(config: Config): Mailer {
  if (!config.smtpUrl) return { enabled: false, async send() {} };
  const from = config.mailFrom ?? `Lager <no-reply@${config.publicUrl.hostname}>`;
  const transport = nodemailer.createTransport(config.smtpUrl);
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
