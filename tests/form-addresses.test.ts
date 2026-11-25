import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { formPageOf } from '../src/http/admin.js';
import { csrfToken } from '../src/http/session.js';
import { PASSWORD, showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

describe('the address of a form, opened again', () => {
  it('leads to the page the form is on: no address the browser can end up on is a dead end', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const user = s.ids.uwe;
    const group = s.ids.group;
    const token = s.h.core.tokens.list(s.h.adminId)[0].id;
    const cases: Array<[string, string]> = [
      ['/account/name', '/account'], ['/account/password', '/account'], ['/account/two-factor/setup', '/account'], ['/account/two-factor/confirm', '/account'],
      ['/verify/resend', '/login'], ['/logout', '/'],
      ['/ui/tokens', '/publish'], [`/ui/tokens/${token}/revoke`, '/publish'],
      ['/ui/instances/notes/grants', '/instances/notes'], ['/ui/instances/notes/restore', '/instances/notes'], ['/ui/apps/notes/collaborators/remove', '/apps/notes'],
      [`/admin/users/${user}/role`, `/admin/users/${user}`], [`/admin/users/${user}/reset-link`, `/admin/users/${user}`],
      [`/admin/groups/${group}/members`, `/admin/groups/${group}`], [`/admin/groups/${group}/delete`, `/admin/groups/${group}`],
      ['/admin/invites/abc/revoke', '/admin/invites'], ['/admin/mail/test', '/admin/mail'], ['/admin/mail/delete', '/admin/mail'],
      ['/admin/ai/providers/p1/test', '/admin/ai/providers/p1'], ['/admin/ai/max-tokens', '/admin/ai'], ['/admin/apps/a1/quota', '/admin/apps'],
      ['/admin/instances/notes/disabled', '/admin/apps'], ['/admin/instances/notes/domains/remove', '/admin/instances/notes/domains'],
    ];
    for (const [path, to] of cases) {
      const res = await request(s.h.app).get(path).set('Host', s.h.host).set('Cookie', cookie);
      expect(res.status, path).toBe(302);
      expect(res.headers.location, path).toBe(to);
    }
    // Opening the sign-out address signs nobody out.
    expect((await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', cookie)).status).toBe(200);
    // Addresses that are no form's stay not found.
    for (const path of ['/admin/nothing/here/at-all', '/ui/nothing']) {
      expect((await request(s.h.app).get(path).set('Host', s.h.host).set('Cookie', cookie)).status, path).toBe(404);
    }
  });

  it('maps only to pages under /admin, never to another site', () => {
    expect(formPageOf('/admin/users/%5C%5Cevil.example/role')).toBe('/admin/users/%5C%5Cevil.example');
    expect(formPageOf('/admin//evil.example/x')).toBeNull();
    expect(formPageOf('/admin/settings')).toBeNull();
    expect(formPageOf('/other/users/x/role')).toBeNull();
  });
});

describe('a form after it is sent', () => {
  it('a test mail goes once: the page it lands on can be reloaded without sending another', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const csrf = csrfToken(s.h.core, s.h.core.users.get(s.h.adminId)!);
    const before = s.mailer.sent.length;
    const res = await request(s.h.app).post('/admin/mail/test').set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf });
    expect(res.status).toBe(302);
    for (let i = 0; i < 2; i++) expect((await request(s.h.app).get(res.headers.location).set('Host', s.h.host).set('Cookie', cookie)).status).toBe(200);
    expect(s.mailer.sent.length - before).toBe(1);
  });

  it('a one-time secret is shown in place and never travels in an address', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const csrf = csrfToken(s.h.core, s.h.core.users.get(s.h.adminId)!);
    const post = (path: string, body: Record<string, string> = {}) =>
      request(s!.h.app).post(path).set('Host', s!.h.host).set('Cookie', cookie).type('form').send({ csrf, ...body });
    const token = await post('/ui/tokens', { name: 'script' });
    expect(token.status).toBe(200);
    expect(token.headers.location).toBeUndefined();
    const reset = await post(`/admin/users/${s.ids.uwe}/reset-link`);
    expect(reset.status).toBe(200);
    expect(reset.headers.location).toBeUndefined();
    expect(reset.text).toContain('/reset?token=');
  });

  it('the address of an administration form tells nobody more than where to sign in', async () => {
    s = await showcase();
    const uwe = await s.h.login('uwe@x.y', PASSWORD);
    for (const cookie of ['', uwe]) {
      const res = await request(s.h.app).get(`/admin/users/${s.ids.pia}/role`).set('Host', s.h.host).set('Cookie', cookie);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/admin/users/${s.ids.pia}`);
      expect(res.text).not.toContain('pia@x.y');
      // Following it: the sign-in, or the administration's own refusal, and nothing of the account.
      const next = await request(s.h.app).get(res.headers.location).set('Host', s.h.host).set('Cookie', cookie);
      expect(next.text).not.toContain('pia@x.y');
      expect(cookie ? next.status : next.headers.location?.startsWith('/login')).toBe(cookie ? 403 : true);
    }
  });
});
