import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { openPlatformDb } from '../src/platform/db.js';
import { Accounts } from '../src/platform/accounts.js';
import { t } from '../src/i18n/index.js';
import { createMailer, MemoryMailer } from '../src/platform/mail.js';
import { Settings, type RegistrationMode } from '../src/platform/settings.js';
import { Users } from '../src/platform/users.js';

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
  it('open registration sends a verification mail', async () => {
    const r = await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    expect(r.needsVerification).toBe(true);
    expect(r.user.verified).toBe(false);
    expect(r.user.role).toBe('user');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('ann@x.y');
    expect(mailer.sent[0].subject).toBe(t('en', 'mail.verify.subject'));
    expect(users.checkLogin('ann@x.y', PW)).toEqual({ ok: false, reason: 'unverified' });
    const token = tokenIn(mailer.sent[0].text, 'token');
    expect(mailer.sent[0].text).toContain('/verify?token=');
    expect(accounts.verifyEmail(token).verified).toBe(true);
    expect(users.get(r.user.id)?.verified).toBe(true);
    expect(users.checkLogin('ann@x.y', PW).ok).toBe(true);
  });

  it('verification link is single use and kind-bound', async () => {
    await accounts.register({ name: 'Ann', email: 'ann@x.y', password: PW });
    const token = tokenIn(mailer.sent[0].text, 'token');
    expect(() => accounts.resetPassword(token, 'another-long-pw')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    accounts.verifyEmail(token);
    expect(() => accounts.verifyEmail(token)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(() => accounts.verifyEmail('garbage')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
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
    expect(() => accounts.resetPassword(reset, 'another-long-pw')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(accounts.getInvite(invite)).not.toBeNull();
    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    expect(() => accounts.verifyEmail(verify)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
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
    expect(r.user).toMatchObject({ role: 'publisher', verified: true });
    expect(r.needsVerification).toBe(false);
    expect(mailer.sent).toHaveLength(0);
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
    expect(() => accounts.resetPassword(token, 'short')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    const r = accounts.resetPassword(token, 'brand-new-password');
    expect(r.verified).toBe(true);
    expect(users.get(u.id)?.sessionEpoch).toBe(1);
    expect(users.verifyPassword('ann@x.y', 'old-password')).toBeNull();
    expect(users.verifyPassword('ann@x.y', 'brand-new-password')?.id).toBe(u.id);
    expect(() => accounts.resetPassword(token, 'yet-another-password')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
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

  it('admin reset link works', () => {
    const u = users.create({ email: 'ann@x.y', name: 'Ann', password: 'old-password', role: 'user' });
    const url = accounts.createResetLink(u.id);
    expect(url).toMatch(/^http:\/\/lager\.test\/reset\?token=/);
    accounts.resetPassword(tokenIn(url, 'token'), 'brand-new-password');
    expect(users.verifyPassword('ann@x.y', 'brand-new-password')?.id).toBe(u.id);
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
    expect(() => accounts.verifyEmail(reset)).toThrow(bad);
    expect(() => accounts.verifyEmail(invite)).toThrow(bad);
    expect(() => accounts.resetPassword(invite, 'brand-new-password')).toThrow(bad);
    expect(accounts.getInvite(reset)).toBeNull();
    // none of the failed attempts consumed anything
    expect(accounts.resetPassword(reset, 'brand-new-password').id).toBe(u.id);
    expect(accounts.getInvite(invite)).not.toBeNull();
  });

  it('using a reset link invalidates other outstanding reset links', () => {
    const u = users.create({ email: 'ann@x.y', name: 'Ann', password: 'old-password', role: 'user' });
    const a = tokenIn(accounts.createResetLink(u.id), 'token');
    const b = tokenIn(accounts.createResetLink(u.id), 'token');
    accounts.resetPassword(a, 'brand-new-password');
    expect(() => accounts.resetPassword(b, 'another-new-password')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
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
