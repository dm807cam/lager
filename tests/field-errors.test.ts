import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { withFieldError } from '../src/http/pages.js';
import { csrfToken, readFlash } from '../src/http/session.js';
import { sealToken } from '../src/http/tokens.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import { PASSWORD, showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const dom = (html: string): Document => new JSDOM(html).window.document;

/** Posts a form, follows the redirect if there is one, and returns the page the browser shows next. */
async function refused(sc: Showcase, cookie: string, userId: string, path: string, body: Record<string, string>): Promise<{ doc: Document; location?: string }> {
  const csrf = csrfToken(sc.h.core, sc.h.core.users.get(userId)!);
  const res = await request(sc.h.app).post(path).set('Host', sc.h.host).set('Cookie', cookie).type('form').send({ csrf, ...body });
  if (res.status !== 302) return { doc: dom(res.text) };
  const location = res.headers.location as string;
  const next = await request(sc.h.app).get(location.split('#')[0]).set('Host', sc.h.host).set('Cookie', cookie);
  return { doc: dom(next.text), location };
}

/** What the page says about control `id`: its message, whether it is marked and focused, its value, and whether a banner repeats it. */
function at(doc: Document, id: string) {
  const control = doc.getElementById(id) as HTMLInputElement;
  const error = doc.getElementById(`${id}-error`);
  return {
    message: error?.textContent?.trim() ?? null,
    invalid: control.getAttribute('aria-invalid'),
    describedBy: control.getAttribute('aria-describedby'),
    focused: control.hasAttribute('autofocus'),
    value: control.getAttribute('value'),
    // The message sits between the label and the control.
    before: error?.nextElementSibling === control,
    banner: doc.querySelectorAll('main .notice-danger').length,
  };
}

const expected = (key: MessageKey, id: string, value: string, params: Record<string, string | number> = {}) =>
  ({ message: t('en', key, params), invalid: 'true', describedBy: `${id}-error`, focused: true, value, before: true, banner: 0 });

describe('a refused form', () => {
  it('shows the message at its field, keeps what was typed and puts the cursor there', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const admin = s.h.adminId;

    // Anyone may register on this server: the person can make an account themselves.
    const open = await refused(s, cookie, admin, '/ui/instances/notes/grants', { email: 'nobody@x.y', level: 'view' });
    expect(open.location).toMatch(/#grant-email$/);
    expect(at(open.doc, 'grant-email')).toEqual(expected('notice.noAccount.open', 'grant-email', 'nobody@x.y'));
    // With invitations only, an administrator can invite the person, and is told where.
    s.h.core.settings.setRegistration('invite');
    const share = await refused(s, cookie, admin, '/ui/instances/notes/grants', { email: 'nobody@x.y', level: 'view' });
    expect(at(share.doc, 'grant-email')).toEqual(expected('notice.noAccount.admin', 'grant-email', 'nobody@x.y'));

    const domain = await refused(s, cookie, admin, '/ui/instances/notes/domains', { host: 'not a host' });
    expect(at(domain.doc, 'domain-host')).toEqual(expected('notice.hostInvalid', 'domain-host', 'not a host'));

    const slug = await refused(s, cookie, admin, '/ui/apps/notes/instances', { slug: 'Not Valid!', owner_email: '' });
    expect(at(slug.doc, 'new-slug')).toEqual(expected('notice.slugInvalid', 'new-slug', 'Not Valid!', { max: 63 }));
    const owner = await refused(s, cookie, admin, '/ui/apps/notes/instances', { slug: 'fine-name', owner_email: 'ghost@x.y' });
    expect(at(owner.doc, 'owner-email')).toEqual(expected('notice.noAccount', 'owner-email', 'ghost@x.y'));
    expect(owner.doc.querySelector<HTMLInputElement>('#new-slug')!.getAttribute('value')).toBe('fine-name');

    const collab = await refused(s, cookie, admin, '/ui/apps/notes/collaborators', { email: 'ghost@x.y' });
    expect(at(collab.doc, 'collab-email')).toEqual(expected('notice.noAccount', 'collab-email', 'ghost@x.y'));

    const confirm = await refused(s, cookie, admin, '/ui/instances/notes/delete', { confirm: 'note' });
    expect(at(confirm.doc, 'confirm')).toEqual(expected('notice.confirmName', 'confirm', 'note'));

    const token = await refused(s, cookie, admin, '/ui/tokens', { name: 'x'.repeat(150) });
    expect(at(token.doc, 'token-name').message).toBe(t('en', 'dash.tokens.nameInvalid', { max: 100 }));
  });

  it('on the home page the closed "get your own" panel opens again at the name', async () => {
    s = await showcase();
    const cookie = await s.h.login('uwe@x.y', PASSWORD);
    const { doc } = await refused(s, cookie, s.ids.uwe, '/ui/apps/tasks/instances', { slug: 'Bad Name', from: 'home' });
    expect(at(doc, 'new-tasks')).toEqual(expected('notice.slugInvalid', 'new-tasks', 'Bad Name', { max: 63 }));
    expect(doc.getElementById('new-tasks')!.closest('details')!.hasAttribute('open')).toBe(true);
    // The other apps' panels stay closed.
    expect([...doc.querySelectorAll('details.getown[open]')]).toHaveLength(1);
  });

  it('in the administration area the page answers in place, with the message at the field', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const admin = s.h.adminId;
    const group = await refused(s, cookie, admin, '/admin/groups', { name: 'Team' });
    expect(at(group.doc, 'group-name')).toEqual(expected('admin.groups.exists', 'group-name', 'Team'));
    const member = await refused(s, cookie, admin, `/admin/groups/${s.ids.group}/members`, { email: 'ghost@x.y' });
    expect(at(member.doc, 'member-email')).toEqual(expected('notice.noAccount', 'member-email', 'ghost@x.y'));
    const invite = await refused(s, cookie, admin, '/admin/invites', { email: 'not-an-address', role: 'user' });
    expect(at(invite.doc, 'invite-email')).toEqual(expected('admin.invites.invalid', 'invite-email', 'not-an-address'));
    const domain = await refused(s, cookie, admin, '/admin/instances/notes/domains', { host: 'not a host' });
    expect(at(domain.doc, 'domain-host')).toEqual(expected('notice.hostInvalid', 'domain-host', 'not a host'));
  });

  it('never puts a password back, and leaves a page without that control alone', () => {
    const html = '<label for="pw">P</label><input id="pw" name="pw" type="password"><label for="e">E</label><input id="e" name="e" value="old">';
    const doc = dom(withFieldError(html, 'e', 'Wrong', { pw: 'secret', e: '<b>"x"</b>' })!);
    expect(doc.getElementById('pw')!.hasAttribute('value')).toBe(false);
    expect(doc.getElementById('e')!.getAttribute('value')).toBe('<b>"x"</b>');
    expect(doc.querySelectorAll('b')).toHaveLength(0);
    expect(withFieldError(html, 'missing', 'Wrong')).toBeNull();
  });
});

describe('only what belongs to a field goes to it', () => {
  it('a control id that is not a plain id is refused, never written into the page', () => {
    const html = '<form><input id="ab" name="a"><input id="cd" name="c"></form>';
    expect(withFieldError(html, 'a"b', 'Wrong')).toBeNull();
    expect(withFieldError(html, 'ab"><script>', 'Wrong')).toBeNull();
    // A value under an id that is not plain is left out; the others are filled in.
    const out = withFieldError(html, 'ab', 'Wrong', { 'c"d': 'x', ab: 'typed' })!;
    expect(out).toContain('value="typed"');
    expect(out).not.toContain('value="x"');
  });

  it('the message describes the field together with its hint', () => {
    const html = '<div class="field"><label for="n">Name</label><input id="n" name="n"><p class="hint" id="n-hint">Lower case.</p></div>';
    const doc = new JSDOM(withFieldError(html, 'n', 'Wrong')!).window.document;
    expect(doc.getElementById('n')!.getAttribute('aria-describedby')).toBe('n-error n-hint');
  });

  it('an app id from the address that is not plain never lands in the page unescaped', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const res = await request(s.h.app).post(`/admin/apps/${encodeURIComponent('x"><b>bold</b>')}/quota`).set('Host', s.h.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.h.core, s.h.core.users.get(s.h.adminId)!), quota: 'lots' });
    expect(res.text).not.toContain('<b>bold</b>');
    expect(res.text).not.toContain('x"><b>');
  });

  it('a refusal that is about no field (a limit) is a notice at the top, and the name is not marked', async () => {
    s = await showcase();
    s.h.core.settings.setMaxInstancesPerUser(1);
    const cookie = await s.h.login('uwe@x.y', PASSWORD);
    s.h.core.apps.createInstance({ appId: s.h.core.apps.getApp('tasks')!.id, slug: 'uwe-one', ownerId: s.ids.uwe });
    const { doc, location } = await refused(s, cookie, s.ids.uwe, '/ui/apps/tasks/instances', { slug: 'uwe-two', from: 'home' });
    expect(location).not.toMatch(/#new-/);
    expect(doc.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(doc.getElementById('notice')!.textContent).toContain(t('en', 'notice.instanceLimit', { max: 1 }));
  });
});

describe('the field in a flash value', () => {
  it('is kept only when it is a plain id and the value was issued to the viewer', async () => {
    s = await showcase();
    const { core } = s.h;
    const admin = core.users.get(s.h.adminId)!;
    const seal = (extra: Record<string, unknown>, uid = admin.id): string => sealToken({ uid, k: 'flash', e: 1, m: 'notice.slugInvalid', ...extra }, core.config.secret, 60);
    expect(readFlash(core, admin, seal({ f: 'new-slug', v: { 'new-slug': 'Bad' } }))).toMatchObject({ field: 'new-slug', values: { 'new-slug': 'Bad' } });
    // Not a plain id, or too many values: the message stays, as a notice at the top, and nothing is filled in.
    expect(readFlash(core, admin, seal({ f: 'Bad Id!' })).field).toBeUndefined();
    expect(readFlash(core, admin, seal({ f: 'a', v: { a: '1', b: '2', c: '3', d: '4', e: '5' } })).values).toBeUndefined();
    // Issued to someone else: nothing at all.
    expect(readFlash(core, core.users.get(s.ids.uwe)!, seal({ f: 'new-slug', v: { 'new-slug': 'Bad' } }))).toEqual({});
  });
});
