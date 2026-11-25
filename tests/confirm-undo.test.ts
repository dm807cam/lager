import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfToken, readFlash } from '../src/http/session.js';
import { sealToken } from '../src/http/tokens.js';
import { t } from '../src/i18n/index.js';
import { showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const dom = (html: string): Document => new JSDOM(html).window.document;

function client(sc: Showcase, cookie: string, userId: string) {
  const csrf = (): string => csrfToken(sc.h.core, sc.h.core.users.get(userId)!);
  return {
    post: (path: string, body: Record<string, string> = {}) =>
      request(sc.h.app).post(path).set('Host', sc.h.host).set('Cookie', cookie).type('form').send({ csrf: csrf(), ...body }),
    get: (path: string) => request(sc.h.app).get(path).set('Host', sc.h.host).set('Cookie', cookie),
  };
}

describe('changes that cannot be taken back ask first', () => {
  it('without the answer, each one shows its question, changes nothing, and the page sends the same fields with the answer', async () => {
    s = await showcase();
    const { core } = s.h;
    const c = client(s, await s.h.login(), s.h.adminId);
    const notes = core.apps.getInstanceBySlug('notes')!;
    core.data.set(notes.id, 'items/one', { text: 'milk' }, null);
    const snap = core.data.snapshot(notes.id, 'keep')!;
    const token = core.tokens.list(s.h.adminId)[0];
    const invite = core.accounts.listInvites().find((i) => !i.used)!;
    const provider = core.ai.createProvider({ name: 'Local', type: 'ollama' });
    core.ai.createModel({ id: 'small', providerId: provider.id, model: 'llama3.2' });
    const aiGroup = core.ai.createGroup({ name: 'Kids', modelId: null, hourlyLimit: 5 });
    const ingestBefore = core.ingest.token(notes.id, 'clips');

    const cases: Array<[string, Record<string, string>, string, () => boolean]> = [
      ['/ui/instances/notes/restore', { snapshot: snap.id }, t('en', 'confirm.restore.title', { label: 'keep' }), () => !core.data.listSnapshots(notes.id).some((x) => x.label === 'pre-restore')],
      ['/ui/instances/notes/ingest/token', { name: 'clips' }, t('en', 'confirm.ingestToken.title', { name: 'clips' }), () => core.ingest.token(notes.id, 'clips') === ingestBefore],
      [`/ui/tokens/${token.id}/revoke`, {}, t('en', 'confirm.tokenRevoke.title', { name: 'laptop' }), () => core.tokens.list(s!.h.adminId).length === 1],
      [`/admin/groups/${s.ids.group}/delete`, {}, t('en', 'confirm.groupDelete.title', { name: 'Team' }), () => core.groups.get(s!.ids.group) !== null],
      [`/admin/invites/${invite.id}/revoke`, {}, t('en', 'confirm.inviteRevoke.title'), () => core.accounts.listInvites().some((i) => i.id === invite.id && !i.used)],
      [`/admin/ai/models/small/delete`, {}, t('en', 'confirm.modelDelete.title', { name: 'small' }), () => core.ai.getModel('small') !== null],
      [`/admin/ai/providers/${provider.id}/delete`, {}, t('en', 'confirm.providerDelete.title', { name: 'Local' }), () => core.ai.getProvider(provider.id) !== null],
      [`/admin/ai/groups/${aiGroup.id}/delete`, {}, t('en', 'confirm.aiGroupDelete.title', { name: 'Kids' }), () => core.ai.getGroup(aiGroup.id) !== null],
    ];
    for (const [path, body, question, unchanged] of cases) {
      const res = await c.post(path, body);
      expect(res.status, path).toBe(200);
      const doc = dom(res.text);
      expect(doc.querySelector('h1')!.textContent, path).toBe(question);
      expect(unchanged(), path).toBe(true);
      // The form sends the same fields again, with the answer; Cancel is a link and comes first.
      const form = doc.querySelector<HTMLFormElement>(`main form[action="${path}"]`)!;
      const sent = Object.fromEntries([...form.querySelectorAll('input[type="hidden"]')].map((i) => [i.getAttribute('name'), i.getAttribute('value')]));
      expect({ ...sent, csrf: undefined }, path).toEqual({ ...body, confirmed: '1', csrf: undefined });
      const [first, second] = [...form.querySelectorAll('.btn-row > *')];
      expect([first.tagName, second.tagName], path).toEqual(['A', 'BUTTON']);
      expect(second.className, path).toContain('btn-danger');
    }
    // With the answer, each one happens.
    expect((await c.post(`/admin/groups/${s.ids.group}/delete`, { confirmed: '1' })).status).toBe(302);
    expect(core.groups.get(s.ids.group)).toBeNull();
    expect((await c.post('/ui/instances/notes/restore', { snapshot: snap.id, confirmed: '1' })).status).toBe(302);
    expect(core.data.listSnapshots(notes.id).some((x) => x.label === 'pre-restore')).toBe(true);
  });

  it('the forms carry their question for the script, in the viewer’s language', async () => {
    s = await showcase();
    const c = client(s, `${await s.h.login()}; lager_lang=fr`, s.h.adminId);
    const publish = dom((await c.get('/publish')).text);
    const revoke = publish.querySelector('form[action$="/revoke"]')!;
    expect(revoke.getAttribute('data-confirm')).toBe(t('fr', 'confirm.tokenRevoke.title', { name: 'laptop' }));
    expect(revoke.getAttribute('data-confirm-text')).toBe(t('fr', 'confirm.tokenRevoke.text'));
    expect(revoke.getAttribute('data-confirm-ok')).toBe(t('fr', 'common.revoke'));
    expect(revoke.getAttribute('data-confirm-cancel')).toBe(t('fr', 'signin.cancel'));
    expect(dom((await c.get(`/admin/groups/${s.ids.group}`)).text).querySelector('form[action$="/delete"]')!.hasAttribute('data-confirm')).toBe(true);
    expect(dom((await c.get('/admin/invites')).text).querySelector('form[action$="/revoke"]')!.hasAttribute('data-confirm')).toBe(true);
  });

  it('the script asks in a dialog, with Cancel focused; only a yes sends the form with the answer', () => {
    const html = `<!doctype html><body><form method="post" action="/x" data-confirm="Delete the group Team?" data-confirm-text="Gone for good."
      data-confirm-ok="Delete group" data-confirm-cancel="Cancel"><button type="submit" id="go">Delete group</button></form></body>`;
    const win = new JSDOM(html, { runScripts: 'outside-only' }).window;
    // jsdom has no modal dialogs and does not send forms: stand-ins that record what happens.
    win.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    win.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new win.Event('close')); };
    const sent: string[] = [];
    win.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { sent.push(new win.URLSearchParams(new win.FormData(this) as unknown as Record<string, string>).toString()); };
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    const doc = win.document;
    const form = doc.querySelector('form')!;
    const ask = (): HTMLDialogElement => {
      form.dispatchEvent(new win.Event('submit', { cancelable: true }));
      return doc.querySelector('dialog')!;
    };
    let dialog = ask();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.querySelector('h2')!.textContent).toBe('Delete the group Team?');
    expect(dialog.querySelector('p')!.textContent).toBe('Gone for good.');
    expect(doc.activeElement!.textContent).toBe('Cancel');
    dialog.querySelector<HTMLButtonElement>('.btn-secondary')!.click();
    expect(doc.querySelector('dialog')).toBeNull();
    expect(sent).toEqual([]);
    expect(form.querySelector('input[name="confirmed"]')).toBeNull();
    dialog = ask();
    dialog.querySelector<HTMLButtonElement>('.btn-danger')!.click();
    expect(sent).toEqual(['confirmed=1']);
  });
});

describe('changes that are easy to redo offer Undo', () => {
  it('removing a share, a member, a collaborator or a domain, or deactivating, can be taken back from the notice', async () => {
    s = await showcase();
    const { core } = s.h;
    const c = client(s, await s.h.login(), s.h.adminId);
    /** Posts, follows the redirect, and sends the notice's Undo form as the browser would. */
    const undo = async (path: string, body: Record<string, string>): Promise<void> => {
      const res = await c.post(path, body);
      expect(res.status, path).toBe(302);
      const doc = dom((await c.get(res.headers.location.split('#')[0])).text);
      const form = doc.querySelector<HTMLFormElement>('.notice-success form.notice-undo')!;
      expect(form, path).not.toBeNull();
      expect(form.querySelector('button')!.textContent).toBe(t('en', 'common.undo'));
      const fields = Object.fromEntries([...form.querySelectorAll('input')].map((i) => [i.getAttribute('name')!, i.getAttribute('value')!]));
      expect((await request(s!.h.app).post(form.getAttribute('action')!).set('Host', s!.h.host).set('Cookie', await s!.h.login()).type('form').send(fields)).status, path).toBe(302);
    };
    const notes = () => core.apps.getInstanceBySlug('notes')!;
    const grantOf = (id: string) => core.access.listGrants(notes().id).find((g) => g.principalId === id);

    await undo('/ui/instances/notes/grants/remove', { type: 'user', id: s.ids.uwe });
    expect(grantOf(s.ids.uwe)?.level).toBe('view');
    await undo('/ui/instances/notes/grants/remove', { type: 'group', id: s.ids.group });
    expect(grantOf(s.ids.group)?.level).toBe('interact');
    await undo('/ui/instances/notes/domains/remove', { host: 'notes.example.com' });
    expect(core.domains.list(notes().id)).toContain('notes.example.com');
    await undo('/ui/apps/notes/collaborators/remove', { id: s.ids.pia });
    expect(core.apps.listCollaborators(notes().appId).map((u) => u.id)).toContain(s.ids.pia);
    await undo(`/admin/groups/${s.ids.group}/members/${s.ids.uwe}/remove`, {});
    expect(core.groups.members(s.ids.group).map((u) => u.id)).toContain(s.ids.uwe);
    await undo(`/admin/users/${s.ids.uwe}/disabled`, { disabled: '1' });
    expect(core.users.get(s.ids.uwe)!.disabled).toBe(false);
    await undo('/admin/instances/notes/disabled', { disabled: '1' });
    expect(notes().disabled).toBe(false);
  });

  it('an Undo can only post to the platform’s own form routes', async () => {
    s = await showcase();
    const { core } = s.h;
    const admin = core.users.get(s.h.adminId)!;
    const sign = (u: unknown): string => sealToken({ uid: admin.id, k: 'flash', e: 0, m: 'notice.ok.saved', u }, core.config.secret, 60);
    expect(readFlash(core, admin, sign({ action: '/ui/instances/notes/grants', fields: { email: 'a@b.c' } })).undo).toEqual({ action: '/ui/instances/notes/grants', fields: { email: 'a@b.c' } });
    for (const action of ['https://evil.example/x', '//evil.example/ui/x', '/login', '/ui/x"><script>', '/admin/../logout']) {
      expect(readFlash(core, admin, sign({ action, fields: {} })).undo, action).toBeUndefined();
    }
    expect(readFlash(core, admin, sign({ action: '/ui/x', fields: { a: { b: 1 } } })).undo).toBeUndefined();
  });
});
