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
import { createMailer, MailSettings, MemoryMailer, smtpErrorText, type SmtpInput } from '../src/platform/mail.js';
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
    // The same host written differently is the same server: the password stays.
    settings.save({ ...BASE, password: undefined, host: ' SMTP.Example.COM ' });
    expect(settings.get()?.host).toBe('smtp.example.com');
    expect((settings.transportOptions(1000)!.options as { auth: { pass: string } }).auth.pass).toBe('p4ss word');
    // Without a user name the password goes.
    settings.save({ ...BASE, user: '', password: undefined });
    expect(settings.get()?.passwordSaved).toBe(false);
    settings.clear();
    expect(settings.get()).toBeNull();
    db.close();
  });

  it('drops the saved password when the server it was entered for changes, unless a new one comes with the change', () => {
    const { db, settings } = store();
    const pass = () => (settings.transportOptions(1000)!.options as { auth?: { pass: string } }).auth?.pass;
    for (const change of [{ host: 'evil.example.net' }, { port: 2525 }, { security: 'none' as const }, { security: 'tls' as const }, { user: 'other@example.com' }]) {
      settings.save(BASE);
      expect(settings.save({ ...BASE, ...change, password: undefined }), JSON.stringify(change)).toEqual({ passwordDropped: true });
      expect(settings.get()?.passwordSaved, JSON.stringify(change)).toBe(false);
      expect(pass(), JSON.stringify(change)).toBe('');
      settings.save({ ...BASE, ...change, password: 'new one' });
      expect(pass(), JSON.stringify(change)).toBe('new one');
    }
    // Changing only the sender keeps it.
    settings.save(BASE);
    expect(settings.save({ ...BASE, from: 'lager@example.com', password: undefined })).toEqual({ passwordDropped: false });
    expect(pass()).toBe('p4ss word');
    db.close();
  });

  it('clear removes its own keys and nothing else', () => {
    const { db, settings } = store();
    db.prepare("INSERT INTO settings (key, value) VALUES ('smtpx', 'keep'), ('registration', 'open')").run();
    settings.save(BASE);
    settings.clear();
    expect(settings.get()).toBeNull();
    expect((db.prepare('SELECT key FROM settings ORDER BY key').all() as Array<{ key: string }>).map((r) => r.key)).toEqual(['registration', 'smtpx']);
    db.close();
  });

  it('a failed test mail shows the error code and the SMTP reply only', () => {
    expect(smtpErrorText(Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' })))
      .toBe('EAUTH: 535 5.7.8 Authentication failed');
    // Another service on the server's network: its banner is not passed on.
    expect(smtpErrorText(Object.assign(new Error('Invalid greeting. response=HTTP/1.1 400 Bad Request: SSH-2.0-OpenSSH'), { code: 'EPROTOCOL', response: 'HTTP/1.1 400 Bad Request' })))
      .toBe('EPROTOCOL');
    expect(smtpErrorText(Object.assign(new Error('x'), { code: 'EPROTOCOL', responseCode: 400, response: 'HTTP/1.1 400 Bad Request' }))).toBe('EPROTOCOL');
    expect(smtpErrorText(new Error('connect ECONNREFUSED 10.0.0.5:22'))).toBe('no SMTP answer');
    expect(smtpErrorText('weird')).toBe('no SMTP answer');
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
      await mailer.send({ to: 'a@x.y', subject: 's', text: 't' });
      expect(smtp.got.rcpt).toEqual([]);

      settings.save({ host: '127.0.0.1', port: smtp.port, security: 'none', user: 'me', password: 'secret', from: 'Home <home@example.com>' });
      expect(mailer.enabled).toBe(true);
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

    // Pointing the settings elsewhere without a password does not take the saved one along.
    const moved = await s.post('/admin/mail', cookie, { host: 'evil.example.net', security: 'none', port: '25', user: 'u@example.com', password: '', from: '' });
    expect(moved.text).toContain(en('admin.mail.savedPasswordDropped'));
    expect(moved.text).toContain(en('admin.mail.cleartext'));
    expect(s.hh.core.mailSettings.get()?.passwordSaved).toBe(false);

    const bad = await s.post('/admin/mail', cookie, { host: 'not a host', security: 'tls', port: '465' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain(en('admin.mail.invalid'));
    expect(s.hh.core.mailSettings.get()?.host).toBe('evil.example.net');

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
    const failing = { enabled: true, async send() { throw Object.assign(new Error('Invalid login: 535 Authentication failed from 10.0.0.5'), { code: 'EAUTH', responseCode: 535, response: '535 Authentication failed' }); } };
    h = makeHarness({ extensions: [adminExtension], mailer: failing as never });
    const hh = h;
    const cookie = await hh.login();
    const res = await request(hh.app).post('/admin/mail/test').set('Host', hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(hh.core, hh.core.users.get(hh.adminId)!) });
    expect(res.text).toContain(en('admin.mail.testFailed', { error: 'EAUTH: 535 Authentication failed' }));
    expect(res.text).not.toContain('10.0.0.5');
  });

  it('a refused save stores no registration mode', async () => {
    const s = setup();
    const cookie = await s.hh.login();
    expect((await s.post('/admin/mail', cookie, { host: 'not a host', security: 'tls' })).status).toBe(400);
    const db = openPlatformDb(s.hh.core.config.dataDir);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'registration'").get()).toBeUndefined();
    db.close();
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
    // A server saved before LAGER_SMTP_URL was set stays until the variable goes; removing it here is refused as well.
    s.hh.core.mailSettings.save(BASE);
    const removed = await s.post('/admin/mail/delete', cookie, {});
    expect(removed.status).toBe(409);
    expect(removed.text).toContain(en('admin.mail.env'));
    expect(s.hh.core.mailSettings.get()).not.toBeNull();
  });

  it('is for administrators with a valid form token only, on every route', async () => {
    const mailer = new MemoryMailer();
    const s = setup({ mailer });
    s.hh.core.mailSettings.save(BASE);
    const body = { host: 'evil.example.net', security: 'tls', port: '465' };
    const routes = ['/admin/mail', '/admin/mail/test', '/admin/mail/delete'];
    const postAs = (p: string, cookie: string | null, csrf: string) => {
      const r = request(s.hh.app).post(p).set('Host', s.hh.host).type('form');
      return (cookie ? r.set('Cookie', cookie) : r).send({ csrf, ...body });
    };
    for (const route of routes) {
      const anon = await postAs(route, null, '');
      expect(anon.status, `anonymous ${route}`).toBe(302);
    }
    expect((await request(s.hh.app).get('/admin/mail').set('Host', s.hh.host)).status).toBe(302);
    for (const role of ['user', 'publisher'] as const) {
      const email = `${role}@x.y`;
      const person = s.hh.core.users.create({ email, name: role, password: 'correct horse battery', role });
      const cookie = await s.hh.login(email, 'correct horse battery');
      expect((await s.get('/admin/mail', cookie)).status, `${role} GET`).toBe(403);
      for (const route of routes) expect((await postAs(route, cookie, csrfToken(s.hh.core, person))).status, `${role} ${route}`).toBe(403);
    }
    const admin = await s.hh.login();
    for (const route of routes) {
      expect((await postAs(route, admin, '')).status, `no token ${route}`).toBe(403);
      expect((await postAs(route, admin, 'wrong')).status, `wrong token ${route}`).toBe(403);
    }
    expect(s.hh.core.mailSettings.get()?.host).toBe('smtp.example.com');
    expect(mailer.sent).toEqual([]);
  });
});
