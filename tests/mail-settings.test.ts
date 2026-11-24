import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { csrfToken } from '../src/http/session.js';
import { esc } from '../src/http/pages.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import { openPlatformDb } from '../src/platform/db.js';
import { Settings } from '../src/platform/settings.js';
import { createMailer, MailSettings, MemoryMailer, type SmtpInput } from '../src/platform/mail.js';
import { makeHarness, type Harness } from './support/http.js';

const en = (key: MessageKey, params?: Record<string, string>): string => esc(t('en', key, params));
const BASE: SmtpInput = { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'lager@example.com', password: 'p4ss word', from: '' };

function store(secret = 'test-secret') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-mail-'));
  const db = openPlatformDb(dir);
  return { db, dir, settings: new MailSettings(db, secret) };
}

/** A mail server that speaks just enough SMTP for nodemailer, accepts AUTH PLAIN and records what it is given. */
async function fakeSmtp() {
  const got = { auth: [] as string[], rcpt: [] as string[], from: [] as string[], data: [] as string[] };
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let body = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; got.data.push(body); body = ''; socket.write('250 queued\r\n'); } else body += line + '\n';
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-fake\r\n250-AUTH PLAIN\r\n250 OK\r\n');
        else if (cmd.startsWith('AUTH PLAIN')) { got.auth.push(Buffer.from(line.slice(11), 'base64').toString('utf8')); socket.write('235 ok\r\n'); }
        else if (cmd.startsWith('MAIL FROM')) { got.from.push(line); socket.write('250 ok\r\n'); }
        else if (cmd.startsWith('RCPT TO')) { got.rcpt.push(line); socket.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { socket.end('221 bye\r\n'); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { got, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('mail server in the administration area', () => {
  it('stores the server, keeps the password encrypted and keeps it when the field is left empty', () => {
    const { db, settings } = store();
    expect(settings.get()).toBeNull();
    settings.save(BASE);
    expect(settings.get()).toMatchObject({ host: 'smtp.example.com', port: 587, security: 'starttls', user: 'lager@example.com', passwordSaved: true, passwordUnreadable: false });
    const raw = db.prepare("SELECT group_concat(value, '|') AS v FROM settings").get() as { v: string };
    expect(raw.v).not.toContain('p4ss word');
    expect((settings.transportOptions(1000)!.options as { auth: { pass: string } }).auth.pass).toBe('p4ss word');
    settings.save({ ...BASE, password: undefined, host: 'Mail.Example.org' });
    expect(settings.get()?.host).toBe('mail.example.org');
    expect((settings.transportOptions(1000)!.options as { auth: { pass: string } }).auth.pass).toBe('p4ss word');
    // Without a user name the password goes.
    settings.save({ ...BASE, user: '', password: undefined });
    expect(settings.get()?.passwordSaved).toBe(false);
    settings.clear();
    expect(settings.get()).toBeNull();
    db.close();
  });

  it('says so when the password no longer decrypts after the secret changed', () => {
    const { db, settings } = store('one');
    settings.save(BASE);
    expect(new MailSettings(db, 'two').get()).toMatchObject({ passwordSaved: true, passwordUnreadable: true });
    db.close();
  });

  it('refuses a host, port, sender or password it cannot use', () => {
    const { db, settings } = store();
    for (const input of [
      { ...BASE, host: '' }, { ...BASE, host: 'smtp://smtp.example.com' }, { ...BASE, host: 'smtp.example.com/x' },
      { ...BASE, port: 0 }, { ...BASE, port: 65536 }, { ...BASE, port: NaN },
      { ...BASE, security: 'ssl' as never },
      { ...BASE, from: 'no address' }, { ...BASE, from: 'a@b.c\r\nBcc: x@y.z' }, { ...BASE, from: 'Lager <a@b.c> extra' },
      { ...BASE, password: 'x'.repeat(501) },
    ]) {
      expect(() => settings.save(input), JSON.stringify(input)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    expect(settings.get()).toBeNull();
    for (const from of ['lager@example.com', 'Lager <lager@example.com>', '"Lager, home" <lager@example.com>']) settings.save({ ...BASE, from });
    db.close();
  });

  it('the mailer follows the saved server without a restart and signs in with the saved user', async () => {
    const smtp = await fakeSmtp();
    const { db, dir, settings } = store();
    try {
      const config = { dataDir: dir, publicUrl: new URL('https://lager.example.com') } as Parameters<typeof createMailer>[0];
      const mailer = createMailer(config, 2000, settings);
      expect(mailer.enabled).toBe(false);
      expect(mailer.source).toBe('none');
      await mailer.send({ to: 'a@x.y', subject: 's', text: 't' });
      expect(smtp.got.rcpt).toEqual([]);

      settings.save({ host: '127.0.0.1', port: smtp.port, security: 'none', user: 'me', password: 'secret', from: 'Home <home@example.com>' });
      expect(mailer.enabled).toBe(true);
      expect(mailer.source).toBe('admin');
      await mailer.send({ to: 'nina@x.y', subject: 'Hello', text: 'Body' });
      expect(smtp.got.auth).toEqual(['\u0000me\u0000secret']);
      expect(smtp.got.from[0]).toContain('home@example.com');
      expect(smtp.got.rcpt[0]).toContain('nina@x.y');
      expect(smtp.got.data[0]).toContain('Subject: Hello');

      // Without a sender of its own the default applies.
      settings.save({ host: '127.0.0.1', port: smtp.port, security: 'none', user: '', from: '' });
      await mailer.send({ to: 'b@x.y', subject: 's', text: 't' });
      expect(smtp.got.auth).toHaveLength(1);
      expect(smtp.got.from[1]).toContain('no-reply@lager.example.com');

      settings.clear();
      expect(mailer.enabled).toBe(false);
    } finally {
      db.close();
      await smtp.close();
    }
  });
});

describe('administration page for mail', () => {
  let h: Harness | undefined;
  afterEach(() => { h?.core.close(); h = undefined; });

  function setup(opts: { mailer?: MemoryMailer; smtpUrl?: string } = {}) {
    h = makeHarness({ extensions: [adminExtension], ...opts });
    const hh = h;
    const post = (p: string, cookie: string, body: Record<string, string>) =>
      request(hh.app).post(p).set('Host', hh.host).set('Cookie', cookie).type('form')
        .send({ csrf: csrfToken(hh.core, hh.core.users.get(hh.adminId)!), ...body });
    const get = (p: string, cookie: string) => request(hh.app).get(p).set('Host', hh.host).set('Cookie', cookie);
    return { hh, post, get };
  }

  it('saving a server turns mail on and keeps registration as it was', async () => {
    const s = setup();
    const cookie = await s.hh.login();
    expect(s.hh.core.mailer.enabled).toBe(false);
    expect(s.hh.core.settings.registration).toBe('invite');
    const page = await s.get('/admin/mail', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain(en('admin.mail.status.off'));
    expect(page.text).toContain('name="host"');
    expect((await s.get('/admin/settings', cookie)).text).toContain('href="/admin/mail"');

    const saved = await s.post('/admin/mail', cookie, { host: 'smtp.example.com', security: 'tls', port: '', user: 'u@example.com', password: 'pw', from: '' });
    expect(saved.status).toBe(200);
    expect(saved.text).toContain(en('admin.mail.saved'));
    expect(saved.text).toContain(en('admin.mail.passwordSaved'));
    expect(saved.text).not.toContain('value="pw"');
    expect(s.hh.core.mailSettings.get()).toMatchObject({ host: 'smtp.example.com', port: 465, security: 'tls' });
    expect(s.hh.core.mailer.enabled).toBe(true);
    expect(s.hh.core.mailSource).toBe('admin');
    // Stored, so a restart (whose default would now be "open") changes nothing.
    const db = openPlatformDb(s.hh.core.config.dataDir);
    expect(new Settings(db, { registration: 'open' }).registration).toBe('invite');
    db.close();

    const bad = await s.post('/admin/mail', cookie, { host: 'not a host', security: 'tls', port: '465' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain(en('admin.mail.invalid'));
    expect(s.hh.core.mailSettings.get()?.host).toBe('smtp.example.com');

    const removed = await s.post('/admin/mail/delete', cookie, {});
    expect(removed.text).toContain(en('admin.mail.removed'));
    expect(s.hh.core.mailer.enabled).toBe(false);
  });

  it('sends a test mail to the administrator', async () => {
    const mailer = new MemoryMailer();
    const s = setup({ mailer });
    const cookie = await s.hh.login();
    s.hh.core.mailSettings.save(BASE);
    const res = await s.post('/admin/mail/test', cookie, {});
    expect(res.status).toBe(200);
    expect(res.text).toContain(en('admin.mail.testOk', { email: 'admin@x.y' }));
    expect(mailer.sent).toEqual([expect.objectContaining({ to: 'admin@x.y', subject: t('en', 'admin.mail.testSubject') })]);
  });

  it('shows what the mail server said when the test mail fails', async () => {
    const failing = { enabled: true, async send() { throw new Error('Invalid login: 535 Authentication failed'); } };
    h = makeHarness({ extensions: [adminExtension], mailer: failing as never });
    const hh = h;
    const cookie = await hh.login();
    const res = await request(hh.app).post('/admin/mail/test').set('Host', hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(hh.core, hh.core.users.get(hh.adminId)!) });
    expect(res.text).toContain(en('admin.mail.testFailed', { error: 'Invalid login: 535 Authentication failed' }));
  });

  it('with LAGER_SMTP_URL the page only says so and refuses a server of its own', async () => {
    const s = setup({ smtpUrl: 'smtp://u:p@127.0.0.1:1' });
    const cookie = await s.hh.login();
    const page = await s.get('/admin/mail', cookie);
    expect(page.text).toContain(en('admin.mail.env'));
    expect(page.text).not.toContain('name="host"');
    const res = await s.post('/admin/mail', cookie, { host: 'smtp.example.com', security: 'tls', port: '465' });
    expect(res.status).toBe(409);
    expect(s.hh.core.mailSettings.get()).toBeNull();
  });

  it('is for administrators only', async () => {
    const s = setup();
    s.hh.core.users.create({ email: 'nina@x.y', name: 'Nina', password: 'correct horse battery', role: 'user' });
    const cookie = await s.hh.login('nina@x.y', 'correct horse battery');
    expect((await s.get('/admin/mail', cookie)).status).toBe(403);
    const nina = s.hh.core.users.getByEmail('nina@x.y')!;
    const res = await request(s.hh.app).post('/admin/mail').set('Host', s.hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.hh.core, nina), host: 'smtp.example.com', security: 'tls' });
    expect(res.status).toBe(403);
    expect(s.hh.core.mailSettings.get()).toBeNull();
  });
});
