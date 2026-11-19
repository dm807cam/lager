import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { openPlatformDb } from '../src/platform/db.js';
import { Accounts } from '../src/platform/accounts.js';
import { t } from '../src/i18n/index.js';
import { createMailer, maskAddress, MemoryMailer } from '../src/platform/mail.js';
import { Settings, type RegistrationMode } from '../src/platform/settings.js';
import { MAX_PASSWORD_LENGTH, Users } from '../src/platform/users.js';

const HOUR = 3600_000;
const config: Config = {
  dataDir: '', port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test',
  secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
  mailFrom: 'Lager <no-reply@lager.test>',
};

let db: ReturnType<typeof openPlatformDb>;
let users: Users;
let settings: Settings;
let mailer: MemoryMailer;
let accounts: Accounts;
function setup(mode: RegistrationMode = 'open'): void {
  settings = new Settings(db, { registration: mode });
  accounts = new Accounts(db, users, settings, mailer, config);
}
const tokenIn = (text: string, param: string): string => {
  const m = new RegExp(`http://lager\\.test/[a-z]+\\?${param}=([A-Za-z0-9_-]+)`).exec(text);
  if (!m) throw new Error(`no link in: ${text}`);
  return m[1];
};
const PW = 'correct-horse-1';

beforeEach(() => {
  db = openPlatformDb(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-accounts-')));
  users = new Users(db);
  mailer = new MemoryMailer();
  setup('open');
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe('Accounts', () => {
  it('a mail that cannot be sent is logged with the recipient masked, also inside the mail server\'s answer', async () => {
    mailer = Object.assign(new MemoryMailer(), { send: async (mail: { to: string }) => { throw new Error(`550 mailbox <${mail.to}> unknown; ${mail.to} rejected`); } });
    setup('open');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await accounts.createInvite({ email: 'jane.doe@example.com', role: 'user', createdBy: users.list()[0]?.id ?? 'x' });
    } finally { spy.mockRestore(); }
    expect(lines).toEqual(['Could not send mail to j***@example.com: Error: 550 mailbox <j***@example.com> unknown; j***@example.com rejected']);
    expect(lines.join('\n')).not.toContain('jane');
    expect(maskAddress('a@b.example')).toBe('a***@b.example');
    expect(maskAddress('"odd@local"@example.org')).toBe('"***@example.org');
    expect(maskAddress('no-at-sign')).toBe('***');
    expect(maskAddress('@example.org')).toBe('***');
  });

  it('open registration sends a verification mail', async () => {
    const r = await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    expect(r.needsVerification).toBe(true);
    expect(r.user.verified).toBe(false);
    expect(r.user.role).toBe('user');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('ann@x.y');
    expect(mailer.sent[0].subject).toBe(t('en', 'mail.verify.subject'));
    expect(await users.checkLogin('ann@x.y', PW)).toEqual({ ok: false, reason: 'unverified' });
    const token = tokenIn(mailer.sent[0].text, 'token');
    expect(mailer.sent[0].text).toContain('/verify?token=');
    expect((await accounts.verifyEmail(token, PW)).verified).toBe(true);
    expect(users.get(r.user.id)?.verified).toBe(true);
    expect((await users.checkLogin('ann@x.y', PW)).ok).toBe(true);
  });

  it('verification link is single use and kind-bound', async () => {
    await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    const token = tokenIn(mailer.sent[0].text, 'token');
    await expect(accounts.resetPassword(token, 'another-long-pw')).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
    await accounts.verifyEmail(token, PW);
    await expect(accounts.verifyEmail(token, PW)).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
    await expect(accounts.verifyEmail('garbage', PW)).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('the link alone confirms nothing: it takes the password of whoever registered', async () => {
    // Someone registers a victim's address with a password only they know; the victim clicks the genuine mail.
    const r = await accounts.register({ name: 'Mallory', email: 'victim@x.y', password: 'the attacker knows this' });
    const token = tokenIn(mailer.sent[0].text, 'token');
    for (const guess of ['', 'the victim guesses', undefined as unknown as string]) {
      await expect(accounts.verifyEmail(token, guess)).rejects.toEqual(expect.objectContaining({ code: 'forbidden', reason: 'password_wrong' }));
    }
    expect(users.get(r.user.id)?.verified).toBe(false);
    expect(await users.checkLogin('victim@x.y', 'the attacker knows this')).toEqual({ ok: false, reason: 'unverified' });
    // A wrong password did not spend the link.
    expect(accounts.checkVerificationToken(token)).toBe(true);
    expect((await accounts.verifyEmail(token, 'the attacker knows this')).verified).toBe(true);
  });

  it('a disabled account gets the invalid-link answer, also with the right password', async () => {
    const r = await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    users.setDisabled(r.user.id, true);
    const token = tokenIn(mailer.sent[0].text, 'token');
    await expect(accounts.verifyEmail(token, PW)).rejects.toEqual(expect.objectContaining({ reason: 'link_invalid' }));
    expect(users.get(r.user.id)?.verified).toBe(false);
  });

  it('a long password is stored whole; one over the limit is refused, never shortened', async () => {
    const long = 'x'.repeat(MAX_PASSWORD_LENGTH);
    const r = await accounts.register({ name: 'Ann', email: 'ann@x.y', password: long });
    await accounts.verifyEmail(tokenIn(mailer.sent[0].text, 'token'), long);
    expect((await users.checkLogin('ann@x.y', long)).ok).toBe(true);
    expect((await users.checkLogin('ann@x.y', long.slice(0, 300))).ok).toBe(false);
    const tooLong = long + 'x';
    await expect(accounts.register({ name: 'Bob', email: 'bob@x.y', password: tooLong })).rejects.toMatchObject({ code: 'invalid_argument', reason: 'password_long' });
    expect(users.getByEmail('bob@x.y')).toBeNull();
    await expect(users.setPassword(r.user.id, tooLong)).rejects.toEqual(expect.objectContaining({ reason: 'password_long' }));
    const reset = tokenIn(accounts.createResetLink(r.user.id), 'token');
    await expect(accounts.resetPassword(reset, tooLong)).rejects.toEqual(expect.objectContaining({ reason: 'password_long' }));
    // The refused password did not spend the reset link.
    expect((await accounts.resetPassword(reset, PW)).id).toBe(r.user.id);
  });

  it('a reset link confirms the address of an account that never did', async () => {
    const r = await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    await accounts.requestPasswordReset('ann@x.y');
    await accounts.resetPassword(tokenIn(mailer.sent[1].text, 'token'), 'a brand new password');
    expect(users.get(r.user.id)?.verified).toBe(true);
    expect((await users.checkLogin('ann@x.y', 'a brand new password')).ok).toBe(true);
  });

  it('expired tokens fail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    const verify = tokenIn(mailer.sent[0].text, 'token');
    await accounts.requestPasswordReset('ann@x.y');
    const reset = tokenIn(mailer.sent[1].text, 'token');
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    const invite = tokenIn((await accounts.createInvite({ email: 'inv@x.y', role: 'user', createdBy: admin.id })).url, 'invite');

    vi.setSystemTime(Date.now() + HOUR + 1000);
    await expect(accounts.resetPassword(reset, 'another-long-pw')).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
    expect(accounts.getInvite(invite)).not.toBeNull();
    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    await expect(accounts.verifyEmail(verify, PW)).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
    vi.setSystemTime(new Date('2026-01-08T00:00:01Z'));
    expect(accounts.getInvite(invite)).toBeNull();
    await expect(accounts.register({ name: 'I', email: 'inv@x.y', password: PW, inviteToken: invite }))
      .rejects.toMatchObject({ code: 'forbidden' });
    setup('invite');
    await expect(accounts.register({ name: 'J', email: 'j@x.y', password: PW, inviteToken: invite }))
      .rejects.toMatchObject({ code: 'forbidden' }); // ...but is not enough in invite mode
  });

  it('without mailer accounts are verified at once', async () => {
    const off = createMailer({ ...config, smtpUrl: undefined });
    expect(off.enabled).toBe(false);
    await expect(off.send({ to: 'a@b.c', subject: 's', text: 't' })).resolves.toBeUndefined();
    accounts = new Accounts(db, users, settings, off, config);
    const r = await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    expect(r.needsVerification).toBe(false);
    expect(r.user.verified).toBe(true);
    expect(createMailer({ ...config, smtpUrl: 'smtp://u:p@127.0.0.1:1' }).enabled).toBe(true);
  });

  it('invite mode requires a valid invite', async () => {
    setup('invite');
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    await expect(accounts.register({ name: 'A', email: 'a@x.y', password: PW })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(accounts.register({ name: 'A', email: 'a@x.y', password: PW, inviteToken: 'bad' })).rejects.toMatchObject({ code: 'forbidden' });
    const { id, url } = await accounts.createInvite({ role: 'publisher', createdBy: admin.id });
    expect(url).toMatch(/^http:\/\/lager\.test\/register\?invite=/);
    const token = tokenIn(url, 'invite');
    const r = await accounts.register({ name: 'A', email: 'a@x.y', password: PW, inviteToken: token });
    // The link was not sent to any address, so it proves none: the invitee confirms theirs like anyone else.
    expect(r.user).toMatchObject({ role: 'publisher', verified: false });
    expect(r.needsVerification).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'a@x.y', subject: t('en', 'mail.verify.subject') });
    expect(await users.checkLogin('a@x.y', PW)).toEqual({ ok: false, reason: 'unverified' });
    expect(accounts.getInvite(token)).toBeNull();
    expect(accounts.listInvites().find((i) => i.id === id)?.used).toBe(true);
    await expect(accounts.register({ name: 'B', email: 'b@x.y', password: PW, inviteToken: token })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('invite bound to an e-mail rejects other addresses', async () => {
    setup('invite');
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    const { url } = await accounts.createInvite({ email: 'Bound@X.y', role: 'user', createdBy: admin.id });
    expect(mailer.sent[0]).toMatchObject({ to: 'Bound@X.y', subject: t('en', 'mail.invite.subject') });
    const token = tokenIn(url, 'invite');
    await expect(accounts.register({ name: 'A', email: 'other@x.y', password: PW, inviteToken: token })).rejects.toMatchObject({ code: 'forbidden' });
    const r = await accounts.register({ name: 'A', email: 'bOUND@x.Y', password: PW, inviteToken: token });
    expect(r.user.verified).toBe(true);
  });

  it('without mail an invitation still gives a usable account, bound or not', async () => {
    accounts = new Accounts(db, users, new Settings(db, { registration: 'invite' }), createMailer({ ...config, smtpUrl: undefined }), config);
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    const { url } = await accounts.createInvite({ role: 'user', createdBy: admin.id });
    const r = await accounts.register({ name: 'A', email: 'a@x.y', password: PW, inviteToken: tokenIn(url, 'invite') });
    expect(r).toMatchObject({ needsVerification: false, user: { verified: true } });
  });

  it('invite is consumed atomically', async () => {
    setup('invite');
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    const { url } = await accounts.createInvite({ role: 'user', createdBy: admin.id });
    const token = tokenIn(url, 'invite');
    await expect(accounts.register({ name: 'A', email: 'root@x.y', password: PW, inviteToken: token })).rejects.toMatchObject({ code: 'conflict' });
    expect(accounts.getInvite(token)).not.toBeNull();
    await expect(accounts.register({ name: 'A', email: 'new@x.y', password: PW, inviteToken: token })).resolves.toBeDefined();
  });

  it('closed mode refuses', async () => {
    setup('closed');
    await expect(accounts.register({ name: 'A', email: 'a@x.y', password: PW })).rejects.toMatchObject({ code: 'forbidden' });
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    const { url } = await accounts.createInvite({ role: 'user', createdBy: admin.id });
    await expect(accounts.register({ name: 'A', email: 'a@x.y', password: PW, inviteToken: tokenIn(url, 'invite') })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('short password and duplicate e-mail', async () => {
    await expect(accounts.register({ name: 'A', email: 'a@x.y', password: '123456789' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await accounts.register({ name: 'A', email: 'a@x.y', password: PW });
    await expect(accounts.register({ name: 'B', email: 'A@X.y', password: PW })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('password reset flow', async () => {
    const u = users.create({ email: 'ann@x.y', name: 'Ann', password: 'old-password', role: 'user', verified: false });
    await accounts.requestPasswordReset('ann@x.y');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'ann@x.y', subject: t('en', 'mail.reset.subject') });
    expect(mailer.sent[0].text).toContain('/reset?token=');
    const token = tokenIn(mailer.sent[0].text, 'token');
    await expect(accounts.resetPassword(token, 'short')).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
    const r = await accounts.resetPassword(token, 'brand-new-password');
    expect(r.verified).toBe(true);
    expect(users.get(u.id)?.sessionEpoch).toBe(1);
    expect(await users.verifyPassword('ann@x.y', 'old-password')).toBeNull();
    expect((await users.verifyPassword('ann@x.y', 'brand-new-password'))?.id).toBe(u.id);
    await expect(accounts.resetPassword(token, 'yet-another-password')).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('reset and resend do not reveal unknown addresses', async () => {
    await expect(accounts.requestPasswordReset('nobody@x.y')).resolves.toBeUndefined();
    await expect(accounts.resendVerification('nobody@x.y')).resolves.toBeUndefined();
    users.create({ email: 'ok@x.y', name: 'O', password: 'x', role: 'user' }); // already verified
    await expect(accounts.resendVerification('ok@x.y')).resolves.toBeUndefined();
    expect(mailer.sent).toHaveLength(0);
    users.create({ email: 'un@x.y', name: 'U', password: 'x', role: 'user', verified: false });
    await accounts.resendVerification('un@x.y');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe(t('en', 'mail.verify.subject'));
  });

  it('admin reset link works', async () => {
    const u = users.create({ email: 'ann@x.y', name: 'Ann', password: 'old-password', role: 'user' });
    const url = accounts.createResetLink(u.id);
    expect(url).toMatch(/^http:\/\/lager\.test\/reset\?token=/);
    await accounts.resetPassword(tokenIn(url, 'token'), 'brand-new-password');
    expect((await users.verifyPassword('ann@x.y', 'brand-new-password'))?.id).toBe(u.id);
    expect(() => accounts.createResetLink('missing')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('invites list and revoke', async () => {
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    const a = await accounts.createInvite({ role: 'user', createdBy: admin.id });
    const b = await accounts.createInvite({ email: 'b@x.y', role: 'publisher', createdBy: admin.id });
    const list = accounts.listInvites();
    expect(list.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ email: 'b@x.y', role: 'publisher', used: false });
    expect(list[1].email).toBeNull();
    const token = tokenIn(a.url, 'invite');
    expect(accounts.getInvite(token)?.id).toBe(a.id);
    expect(accounts.revokeInvite(a.id)).toBe(true);
    expect(accounts.revokeInvite(a.id)).toBe(false);
    expect(accounts.getInvite(token)).toBeNull();
    expect(accounts.listInvites().map((i) => i.id)).toEqual([b.id]);
  });

  it('tokens are bound to their kind', async () => {
    const admin = users.create({ email: 'root@x.y', name: 'R', password: 'x', role: 'admin' });
    const u = users.create({ email: 'ann@x.y', name: 'Ann', password: 'old-password', role: 'user', verified: false });
    const reset = tokenIn(accounts.createResetLink(u.id), 'token');
    const invite = tokenIn((await accounts.createInvite({ role: 'user', createdBy: admin.id })).url, 'invite');
    const bad = expect.objectContaining({ code: 'invalid_argument' });
    await expect(accounts.verifyEmail(reset, PW)).rejects.toEqual(bad);
    await expect(accounts.verifyEmail(invite, PW)).rejects.toEqual(bad);
    await expect(accounts.resetPassword(invite, 'brand-new-password')).rejects.toEqual(bad);
    expect(accounts.getInvite(reset)).toBeNull();
    // none of the failed attempts consumed anything
    expect((await accounts.resetPassword(reset, 'brand-new-password')).id).toBe(u.id);
    expect(accounts.getInvite(invite)).not.toBeNull();
  });

  it('using a reset link invalidates other outstanding reset links', async () => {
    const u = users.create({ email: 'ann@x.y', name: 'Ann', password: 'old-password', role: 'user' });
    const a = tokenIn(accounts.createResetLink(u.id), 'token');
    const b = tokenIn(accounts.createResetLink(u.id), 'token');
    await accounts.resetPassword(a, 'brand-new-password');
    await expect(accounts.resetPassword(b, 'another-new-password')).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('reset and resend do not wait for delivery', async () => {
    users.create({ email: 'un@x.y', name: 'U', password: 'x', role: 'user', verified: false });
    const started: string[] = [];
    const slow = {
      enabled: true,
      send: (m: { subject: string }) => { started.push(m.subject); return new Promise<void>(() => {}); },
    };
    accounts = new Accounts(db, users, settings, slow, config);
    await accounts.resendVerification('un@x.y');
    await accounts.requestPasswordReset('un@x.y');
    await accounts.resendVerification('nobody@x.y');
    await accounts.requestPasswordReset('nobody@x.y');
    expect(started).toEqual([t('en', 'mail.verify.subject'), t('en', 'mail.reset.subject')]);
  });

  it('a failing detached send is not an unhandled rejection', async () => {
    users.create({ email: 'un@x.y', name: 'U', password: 'x', role: 'user', verified: false });
    const failing = { enabled: true, send: () => Promise.reject(new Error('smtp down')) };
    accounts = new Accounts(db, users, settings, failing, config);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await accounts.requestPasswordReset('un@x.y');
    await accounts.resendVerification('un@x.y');
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('only stores token hashes', async () => {
    await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    const token = tokenIn(mailer.sent[0].text, 'token');
    expect(JSON.stringify(db.prepare('SELECT * FROM account_tokens').all())).not.toContain(token);
  });
});
