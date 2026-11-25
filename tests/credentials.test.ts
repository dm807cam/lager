import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { csrfToken } from '../src/http/session.js';
import { makeHarness, type Harness } from './support/http.js';
import { t } from '../src/i18n/index.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new password';

/** A user with an OAuth grant (access + refresh token + a pending code), an API token and a pending reset link. */
function fixture() {
  h = makeHarness();
  const { core } = h;
  const user = core.users.create({ email: 'ann@example.org', name: 'Ann', password: PASSWORD, role: 'publisher' });
  core.oauth.registerClient({ client_id: 'c1', redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' } as never);
  const tokens = core.oauth.issueTokens('c1', user.id, 'g1', 'lager', null);
  const code = core.oauth.issueCode({ clientId: 'c1', userId: user.id, redirectUri: 'https://claude.ai/cb', codeChallenge: 'x', scopes: ['lager'] });
  const api = core.tokens.create(user.id, 'cli').token;
  const resetToken = new URL(core.accounts.createResetLink(user.id)).searchParams.get('token')!;
  const alive = {
    access: () => core.oauth.verifyAccessToken(tokens.access_token) !== null,
    refresh: () => { try { core.oauth.rotateRefreshToken('c1', tokens.refresh_token); return true; } catch { return false; } },
    code: () => core.oauth.consumeCode(code) !== null,
    api: () => core.tokens.verify(api) !== null,
  };
  return { core, user, resetToken, alive };
}

describe('credentials do not survive password changes', () => {
  it('account-page password change revokes OAuth tokens and codes, API tokens and reset links', async () => {
    const f = fixture();
    expect([f.alive.access(), f.alive.api()]).toEqual([true, true]);
    const cookie = await h!.login('ann@example.org', PASSWORD);
    const res = await request(h!.app).post('/account/password').set('Host', h!.host).set('Cookie', cookie).type('form')
      .send({ current: PASSWORD, password: NEW_PASSWORD, csrf: csrfToken(f.core, f.user) });
    expect(res.status).toBe(302);
    expect(f.alive.access()).toBe(false);
    expect(f.alive.refresh()).toBe(false);
    expect(f.alive.code()).toBe(false);
    // Whoever changes a password because it leaked must not leave a deploy credential behind.
    expect(f.alive.api()).toBe(false);
    expect(f.core.tokens.list(f.user.id)).toEqual([]);
    const dead = await request(h!.app).post('/reset').set('Host', h!.host).type('form').send({ token: f.resetToken, password: 'yet another password' });
    expect(dead.status).toBe(400);
    expect(dead.text).toContain(t('en', 'auth.reset.invalid'));
  });

  it('password reset revokes OAuth tokens, codes and API tokens and says so', async () => {
    const f = fixture();
    const res = await request(h!.app).post('/reset').set('Host', h!.host).type('form').send({ token: f.resetToken, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.text).toContain(t('en', 'auth.reset.done'));
    expect(f.alive.access()).toBe(false);
    expect(f.alive.refresh()).toBe(false);
    expect(f.alive.code()).toBe(false);
    expect(f.alive.api()).toBe(false);
  });

  it('disabling an account revokes its OAuth tokens and codes for good', () => {
    const f = fixture();
    f.core.users.setDisabled(f.user.id, true);
    f.core.users.setDisabled(f.user.id, false);
    expect(f.alive.access()).toBe(false);
    expect(f.alive.refresh()).toBe(false);
    expect(f.alive.code()).toBe(false);
    expect(f.alive.api()).toBe(true);
  });
});

describe('invitations of a demoted or disabled administrator', () => {
  it('stop working when the role is lost', async () => {
    h = makeHarness();
    const { core } = h;
    const boss = core.users.create({ email: 'boss@example.org', name: 'Boss', password: PASSWORD, role: 'admin' });
    const keeper = core.users.create({ email: 'keeper@example.org', name: 'Keeper', password: PASSWORD, role: 'admin' });
    const mine = await core.accounts.createInvite({ role: 'user', createdBy: boss.id });
    const theirs = await core.accounts.createInvite({ role: 'user', createdBy: keeper.id });
    const tokenOf = (url: string): string => new URL(url).searchParams.get('invite')!;
    core.users.setRole(boss.id, 'publisher');
    expect(core.accounts.getInvite(tokenOf(mine.url))).toBeNull();
    expect(core.accounts.getInvite(tokenOf(theirs.url))).not.toBeNull();
    expect(core.accounts.listInvites().map((i) => i.id)).toEqual([theirs.id]);
  });

  it('stop working when the account is disabled', async () => {
    h = makeHarness();
    const { core } = h;
    const boss = core.users.create({ email: 'boss@example.org', name: 'Boss', password: PASSWORD, role: 'admin' });
    const invite = await core.accounts.createInvite({ role: 'user', createdBy: boss.id });
    core.users.setDisabled(boss.id, true);
    expect(core.accounts.getInvite(new URL(invite.url).searchParams.get('invite')!)).toBeNull();
  });
});
