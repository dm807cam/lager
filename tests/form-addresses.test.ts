import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { formPageOf } from '../src/http/admin.js';
import { showcase, type Showcase } from './support/pages.js';

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
