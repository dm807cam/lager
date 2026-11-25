import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfToken, flashToken, readFlash } from '../src/http/session.js';
import { withNotice } from '../src/http/pages.js';
import { sealToken, signToken } from '../src/http/tokens.js';
import { t } from '../src/i18n/index.js';
import { PASSWORD, showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const dom = (html: string): Document => new JSDOM(html).window.document;

/** Posts a form as `who` and follows the redirect: what the browser shows next, and where it went. */
async function submit(sc: Showcase, cookie: string, userId: string, path: string, body: Record<string, string> = {}) {
  const user = sc.h.core.users.get(userId)!;
  const res = await request(sc.h.app).post(path).set('Host', sc.h.host).set('Cookie', cookie).type('form').send({ csrf: csrfToken(sc.h.core, user), ...body });
  expect(res.status, path).toBe(302);
  const location = res.headers.location as string;
  const next = await request(sc.h.app).get(location.split('#')[0]).set('Host', sc.h.host).set('Cookie', cookie);
  expect(next.status, location).toBe(200);
  return { location, doc: dom(next.text) };
}

/** The notice of a page: its text, and the id of the element right after it (the section it stands above). */
function noticeOf(doc: Document): { text: string; before: string | null; role: string | null } | null {
  const n = doc.getElementById('notice');
  if (!n) return null;
  return { text: n.textContent!.trim(), before: n.nextElementSibling?.id || null, role: n.getAttribute('role') };
}

describe('after a form', () => {
  it('the instance page says what changed, right above the card that changed', async () => {
    s = await showcase();
    const { core } = s.h;
    const cookie = await s.h.login();
    const admin = s.h.adminId;
    const base = '/ui/instances/notes';

    const visible = await submit(s, cookie, admin, `${base}/visibility`, { visibility: 'public' });
    expect(visible.location).toMatch(/^\/instances\/notes\?flash=[^#]+#notice$/);
    expect(noticeOf(visible.doc)).toEqual({ text: t('en', 'notice.ok.public', { slug: 'notes' }), before: 'details', role: 'status' });

    const shared = await submit(s, cookie, admin, `${base}/grants`, { email: 'pia@x.y', level: 'interact' });
    // The address is in the notice, not in the address bar.
    expect(decodeURIComponent(shared.location)).not.toContain('pia');
    expect(noticeOf(shared.doc)).toEqual({ text: t('en', 'notice.ok.shared', { name: 'pia@x.y', level: t('en', 'level.interact') }), before: 'sharing', role: 'status' });
    const removed = await submit(s, cookie, admin, `${base}/grants/remove`, { type: 'user', id: s.ids.pia });
    expect(noticeOf(removed.doc)!.text).toBe(t('en', 'notice.ok.unshared', { name: 'pia@x.y' }));

    // Version 2 declares the endpoints for data from outside; version 1 does not.
    const ingest = await submit(s, cookie, admin, `${base}/ingest/switch`, { name: 'clips', on: '0' });
    expect(noticeOf(ingest.doc)).toMatchObject({ text: t('en', 'notice.ok.ingestOff', { name: 'clips' }), before: 'ingest' });

    const activated = await submit(s, cookie, admin, `${base}/activate`, { version: '1' });
    expect(noticeOf(activated.doc)).toMatchObject({ text: t('en', 'notice.ok.activated', { version: '1' }), before: 'versions' });

    const notes = core.apps.getInstanceBySlug('notes')!.id;
    core.data.set(notes, 'items/one', { text: 'milk' }, null);
    const snapshot = core.data.snapshot(notes, 'before-import')!;
    const restored = await submit(s, cookie, admin, `${base}/restore`, { snapshot: snapshot.id });
    expect(noticeOf(restored.doc)).toMatchObject({ text: t('en', 'notice.ok.restored', { label: 'before-import' }), before: 'data' });

    const off = await submit(s, cookie, admin, `${base}/auto-update`, { on: '0' });
    expect(noticeOf(off.doc)!.text).toBe(t('en', 'notice.ok.autoUpdateOff', { version: '1' }));
    // Every placeholder is filled: the version is in the text itself.
    expect(noticeOf(off.doc)!.text).toMatch(/version 1\b/);
    // Version 1 is active and 2 the latest: switching updates on moves the instance there at once, and the notice says so.
    const moved = await submit(s, cookie, admin, `${base}/auto-update`, { on: '1' });
    expect(noticeOf(moved.doc)!.text).toBe(t('en', 'notice.ok.autoUpdateMoved', { version: '2' }));
    await submit(s, cookie, admin, `${base}/auto-update`, { on: '0' });
    const on = await submit(s, cookie, admin, `${base}/auto-update`, { on: '1' });
    expect(noticeOf(on.doc)!.text).toBe(t('en', 'notice.ok.autoUpdateOn'));
    const badge = await submit(s, cookie, admin, `${base}/badge`, { on: '0' });
    expect(noticeOf(badge.doc)!.text).toBe(t('en', 'notice.ok.badgeOff'));

    const domain = await submit(s, cookie, admin, `${base}/domains`, { host: 'Notes2.Example.com' });
    expect(noticeOf(domain.doc)).toMatchObject({ text: t('en', 'notice.ok.domainAdded', { host: 'notes2.example.com' }), before: 'domains' });

    // Deleting lands on the home page, which says what became of the instance.
    const deleted = await submit(s, cookie, admin, `${base}/delete`, { confirm: 'notes' });
    expect(deleted.location).toMatch(/^\/\?flash=/);
    expect(noticeOf(deleted.doc)!.text).toBe(t('en', 'notice.ok.instanceDeleted', { slug: 'notes' }));
  });

  it('the app page, the home page and the publish page say what happened', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const admin = s.h.adminId;
    const collab = await submit(s, cookie, admin, '/ui/apps/notes/collaborators/remove', { id: s.ids.pia });
    expect(noticeOf(collab.doc)).toMatchObject({ text: t('en', 'notice.ok.collaboratorRemoved', { name: 'Pia Publisher' }), before: 'collaborators' });
    // The id of someone who does not work on the app is not turned into a name.
    const stranger = await submit(s, cookie, admin, '/ui/apps/notes/collaborators/remove', { id: s.ids.uwe });
    expect(noticeOf(stranger.doc)!.text).toBe(t('en', 'notice.missing'));
    expect(stranger.doc.body.textContent).not.toContain('Uwe');
    const created = await submit(s, cookie, admin, '/ui/apps/notes/instances', { slug: 'notes-two' });
    expect(noticeOf(created.doc)).toMatchObject({ text: t('en', 'notice.ok.instanceCreated', { slug: 'notes-two' }), before: 'instances' });

    // A user who gets their own instance from the catalog sees it named above their own instances.
    const uwe = await s.h.login('uwe@x.y', PASSWORD);
    const own = await submit(s, uwe, s.ids.uwe, '/ui/apps/tasks/instances', { slug: 'uwe-tasks', from: 'home' });
    expect(noticeOf(own.doc)).toMatchObject({ text: t('en', 'notice.ok.instanceCreated', { slug: 'uwe-tasks' }), before: 'mine' });

    const token = s.h.core.tokens.list(admin)[0];
    const revoked = await submit(s, cookie, admin, `/ui/tokens/${token.id}/revoke`);
    expect(noticeOf(revoked.doc)).toMatchObject({ text: t('en', 'notice.ok.tokenRevoked', { name: 'laptop' }), before: 'tokens' });
  });

  it('the administration area says what happened, in the viewer’s language', async () => {
    s = await showcase();
    const cookie = `${await s.h.login()}; lager_lang=de`;
    const admin = s.h.adminId;
    s.h.core.users.setLocale(admin, 'de');
    const notice = (doc: Document): string => doc.querySelector('main .notice-success')!.textContent!.trim();
    expect(notice((await submit(s, cookie, admin, '/admin/settings', { registration: 'open', maxInstances: '20' })).doc)).toBe(t('de', 'notice.ok.saved'));
    expect(notice((await submit(s, cookie, admin, `/admin/users/${s.ids.uwe}/role`, { role: 'publisher' })).doc))
      .toBe(t('de', 'notice.ok.role', { name: 'Uwe', role: t('de', 'role.publisher') }));
    expect(notice((await submit(s, cookie, admin, `/admin/users/${s.ids.uwe}/disabled`, { disabled: '1' })).doc)).toBe(t('de', 'notice.ok.userDisabled', { name: 'Uwe' }));
    expect(notice((await submit(s, cookie, admin, `/admin/groups/${s.ids.group}/delete`)).doc)).toBe(t('de', 'notice.ok.deleted', { name: 'Team' }));
    expect(notice((await submit(s, cookie, admin, '/admin/instances/old-notes/disabled', { disabled: '0' })).doc)).toBe(t('de', 'notice.ok.instanceEnabled', { slug: 'old-notes' }));
  });
});

describe('the flash value', () => {
  it('carries a message, its values and a place; anything forged or malformed is ignored', async () => {
    s = await showcase();
    const { core } = s.h;
    const admin = core.users.get(s.h.adminId)!;
    const uwe = core.users.get(s.ids.uwe)!;
    const token = flashToken(core, admin, { ok: 'notice.ok.shared', params: { name: 'a@b.c', level: 'Viewer' }, anchor: 'sharing' });
    expect(readFlash(core, admin, token)).toEqual({ ok: 'notice.ok.shared', params: { name: 'a@b.c', level: 'Viewer' }, anchor: 'sharing' });
    // The values cannot be read from the address: it ends up in browser history and in the logs of reverse proxies.
    expect(Buffer.from(token, 'base64url').toString('latin1')).not.toContain('a@b.c');
    expect(token).not.toContain('a@b.c');
    // Issued to someone else, sealed with another secret, or only signed: nothing.
    expect(readFlash(core, uwe, token)).toEqual({});
    expect(readFlash(core, admin, sealToken({ uid: admin.id, k: 'flash', e: 0, m: 'notice.ok.saved' }, 'x'.repeat(40), 60))).toEqual({});
    expect(readFlash(core, admin, signToken({ uid: admin.id, k: 'flash', e: 0, m: 'notice.ok.saved' }, core.config.secret, 60))).toEqual({});
    // Values that are not plain short strings, and places that are not plain words, are dropped; the message stays.
    const sign = (extra: Record<string, unknown>): string => sealToken({ uid: admin.id, k: 'flash', e: 0, m: 'notice.ok.saved', ...extra }, core.config.secret, 60);
    expect(readFlash(core, admin, sign({ p: { name: { nested: 1 } }, a: '"><script>' }))).toEqual({ ok: 'notice.ok.saved' });
    expect(readFlash(core, admin, sign({ p: { name: 'x'.repeat(301) } }))).toEqual({ ok: 'notice.ok.saved' });
    // A value too long for a notice is cut where it is written, so the notice keeps its other values.
    const long = readFlash(core, admin, flashToken(core, admin, { ok: 'notice.ok.shared', params: { name: 'n'.repeat(500), level: 'Viewer' } }));
    expect(long.params!.level).toBe('Viewer');
    expect(long.params!.name).toBe(`${'n'.repeat(299)}…`);
  });

  it('values are text: markup in a name is shown, not run', () => {
    const html = withNotice('en', { ok: 'notice.ok.added', params: { name: '<img src=x onerror=alert(1)>' }, anchor: 'sharing' }, '<p>a</p><section id="sharing">b</section>');
    const doc = dom(html);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.getElementById('notice')!.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(doc.getElementById('notice')!.nextElementSibling!.id).toBe('sharing');
    // Without that section on the page, the notice goes to the top.
    expect(withNotice('en', { ok: 'notice.ok.saved', anchor: 'nowhere' }, '<p>a</p>').startsWith('<div id="notice"')).toBe(true);
    expect(withNotice('en', {}, '<p>a</p>')).toBe('<p>a</p>');
  });
});
