import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { esc } from '../src/http/pages.js';
import { signToken } from '../src/http/tokens.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness } from './support/http.js';

const en = (key: MessageKey): string => esc(t('en', key));
let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const setup = (): Harness => (h = makeHarness({ extensions: [dashboardExtension, manageExtension] }));
const csrfOf = (hh: Harness, userId: string): string => signToken({ uid: userId, k: 'ui', ep: hh.core.users.get(userId)?.sessionEpoch }, hh.core.config.secret, 3600);
const csrfFor = (hh: Harness): string => csrfOf(hh, hh.adminId);
const get = (hh: Harness, cookie: string, path = '/') => request(hh.app).get(path).set('Host', hh.host).set('Cookie', cookie);
const post = (hh: Harness, cookie: string, path: string, body: Record<string, string>) =>
  request(hh.app).post(path).set('Host', hh.host).set('Cookie', cookie).type('form').send(body);

function addUser(hh: Harness, email: string, role: 'publisher' | 'user' = 'user'): User {
  return hh.core.users.create({ email, name: email.split('@')[0], password: 'password-123', role });
}

/** Publisher `p` owns app `notes` (title "Notes") with instance `notes`; plain users `u` and `w`. */
function scenario(hh: Harness): { p: User; u: User; w: User } {
  const p = addUser(hh, 'p@x.y', 'publisher');
  const u = addUser(hh, 'u@x.y');
  const w = addUser(hh, 'w@x.y');
  hh.core.apps.deploy({ slug: 'notes', html: '<p>1</p>', title: 'Notes', userId: p.id });
  return { p, u, w };
}
const loginAs = (hh: Harness, user: User): Promise<string> => hh.login(user.email, 'password-123');

describe('home page', () => {
  it('redirects to /login without session', async () => {
    const h = setup();
    const res = await request(h.app).get('/').set('Host', h.host);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?return=%2F');
  });

  it('POST without a session redirects to /login?return=/ (not the form path)', async () => {
    const h = setup();
    const res = await request(h.app).post('/ui/tokens').set('Host', h.host).type('form').send({ name: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?return=%2F');
  });

  it('the logout form carries a csrf token', async () => {
    const h = setup();
    const res = await get(h, await h.login());
    const m = /action="\/logout"><input type="hidden" name="csrf" value="([^"]+)"/.exec(res.text);
    expect(m).not.toBeNull();
    const out = await request(h.app).post('/logout').set('Host', h.host).set('Cookie', await h.login()).type('form').send({ csrf: m![1] });
    expect(out.status).toBe(302);
  });

  it('plain user sees no publisher sections', async () => {
    const h = setup();
    const { u } = scenario(h);
    const res = await get(h, await loginAs(h, u));
    expect(res.status).toBe(200);
    // Nothing of their own, nothing shared, no catalog: the empty home with the tagline, and no steps (they cannot connect an AI assistant).
    expect(res.text).toContain(en('brand.tagline'));
    expect(res.text).toContain(en('dash.noInstances'));
    expect(res.text).toContain(en('home.empty.user'));
    expect(res.text).not.toContain(en('home.step.ask'));
    for (const text of [en('dash.apps'), en('dash.tokens'), en('dash.connect'), '/mcp']) expect(res.text).not.toContain(text);
    expect(res.text).not.toContain(en('nav.admin'));
  });

  it('publisher sees apps, connector and tokens', async () => {
    const h = setup();
    const { p } = scenario(h);
    h.core.apps.deploy({ slug: 'notes', html: '<p>2</p>', userId: p.id });
    const cookie = await loginAs(h, p);
    // Publishing has its own page; the home page keeps the instances.
    const home = await get(h, cookie);
    expect(home.text).toContain('href="/publish"');
    for (const text of [en('dash.apps'), en('dash.tokens'), en('dash.connect'), '/mcp']) expect(home.text).not.toContain(text);
    const res = await get(h, cookie, '/publish');
    expect(res.text).toContain(en('dash.apps'));
    expect(res.text).toContain('Notes');
    expect(res.text).toContain('href="/apps/notes"');
    expect(res.text).toContain('v2');
    expect(res.text).toContain(en('dash.connect'));
    expect(res.text).toContain('http://lager.localhost:8080/mcp');
    expect(res.text).toContain(en('dash.tokens'));
    expect(home.text).toContain(en('dash.ownInstances'));
    expect(home.text).toContain('href="http://notes.apps.localhost:8080"');
    expect(home.text).toContain('href="/instances/notes"');
    expect(home.text).toContain(en('visibility.private'));
  });

  it('administrators see the same sections and the Administration link', async () => {
    const h = setup();
    h.core.apps.deploy({ slug: 'notes', html: '<p>1</p>', title: 'Notes', userId: h.adminId });
    const cookie = await h.login();
    const res = await get(h, cookie, '/publish');
    expect(res.text).toContain(en('dash.apps'));
    expect(res.text).toContain(en('dash.connect'));
    expect(res.text).toContain('href="/admin"');
    expect((await get(h, cookie)).text).toContain('href="/admin"');
  });

  it('the account page of an administrator links to the administration', async () => {
    const h = setup();
    const res = await request(h.app).get('/account').set('Host', h.host).set('Cookie', await h.login());
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/admin"');
  });

  it('shared instance appears under "Shared with me" with the level', async () => {
    const h = setup();
    const { p, u, w } = scenario(h);
    const inst = h.core.apps.getInstanceBySlug('notes')!;
    h.core.access.setGrant(inst, 'user', u.id, 'view', p);
    h.core.access.setGrant(inst, 'user', w.id, 'admin', p);
    const forU = await get(h, await loginAs(h, u));
    expect(forU.text).toContain(en('dash.shared'));
    expect(forU.text).toContain('Notes');
    expect(forU.text).toContain(en('level.view'));
    expect(forU.text).not.toContain('href="/instances/notes"');
    const forW = await get(h, await loginAs(h, w));
    expect(forW.text).toContain(en('level.admin'));
    expect(forW.text).toContain('href="/instances/notes"');
    const forP = await get(h, await loginAs(h, p));
    expect(forP.text).not.toContain(en('dash.shared'));
  });

  it('catalog lists users-visible instances and self-service apps', async () => {
    const h = setup();
    const { p, u } = scenario(h);
    const empty = await get(h, await loginAs(h, u));
    expect(empty.text).not.toContain(en('dash.catalog'));
    const inst = h.core.apps.getInstanceBySlug('notes')!;
    h.core.apps.setVisibility(inst.id, 'users', p.id);
    h.core.apps.deploy({ slug: 'todo', html: '<p>t</p>', title: 'Tasks', userId: p.id });
    const app = h.core.apps.getApp('todo')!;
    h.core.apps.setSelfInstances(app.id, 'users', p.id);
    const res = await get(h, await loginAs(h, u));
    expect(res.text).toContain(en('dash.catalog'));
    expect(res.text).toContain('href="http://notes.apps.localhost:8080"');
    expect(res.text).toContain('Tasks');
    expect(res.text).toContain(en('dash.createOwn'));
    expect(res.text).toContain('action="/ui/apps/todo/instances"');
  });

  it('self-service creates an own instance', async () => {
    const h = setup();
    const { p, u } = scenario(h);
    const app = h.core.apps.getApp('notes')!;
    const cookie = await loginAs(h, u);
    const refused = await post(h, cookie, '/ui/apps/notes/instances', { slug: 'mine', csrf: csrfOf(h, u.id) });
    expect(refused.status).toBe(403);
    expect(h.core.apps.getInstanceBySlug('mine')).toBeNull();
    h.core.apps.setSelfInstances(app.id, 'users', p.id);
    const res = await post(h, cookie, '/ui/apps/notes/instances', { slug: 'mine', csrf: csrfOf(h, u.id) });
    expect(res.status).toBe(302);
    expect(res.headers.location.split('?')[0]).toBe('/');
    expect(h.core.apps.getInstanceBySlug('mine')!.ownerId).toBe(u.id);
    const home = await get(h, cookie);
    expect(home.text).toContain('href="http://mine.apps.localhost:8080"');
    expect(home.text).toContain('href="/instances/mine"');
  });

  it('escapes titles', async () => {
    const h = setup();
    h.core.apps.deploy({ slug: 'xss', html: '<p>x</p>', title: '<script>alert(1)</script>', note: '"><img src=x onerror=alert(2)>', userId: h.adminId });
    const res = await get(h, await h.login());
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).not.toContain('<img src=x');
  });

  it('new token is shown once', async () => {
    const h = setup();
    const cookie = await h.login();
    const created = await post(h, cookie, '/ui/tokens', { name: 'laptop', csrf: csrfFor(h) });
    expect(created.status).toBe(200);
    const token = /lgr_[A-Za-z0-9_-]+/.exec(created.text)?.[0];
    expect(token).toBeTruthy();
    expect(h.core.tokens.verify(token!)?.id).toBe(h.adminId);
    const after = await get(h, cookie, '/publish');
    expect(after.text).toContain('laptop');
    expect(after.text).not.toContain(token!);
    const info = h.core.tokens.list(h.adminId)[0];
    const revoke = await post(h, cookie, `/ui/tokens/${info.id}/revoke`, { csrf: csrfFor(h) });
    expect(revoke.status).toBe(302);
    expect(revoke.headers.location.split('?')[0]).toBe('/publish');
    expect(h.core.tokens.list(h.adminId)).toHaveLength(0);
  });

  it('token routes need csrf and a deploying role', async () => {
    const h = setup();
    const { u } = scenario(h);
    const none = await post(h, await h.login(), '/ui/tokens', { name: 'x' });
    expect(none.status).toBe(403);
    const plain = await post(h, await loginAs(h, u), '/ui/tokens', { name: 'x', csrf: csrfOf(h, u.id) });
    expect(plain.status).toBe(403);
    expect(h.core.tokens.list(u.id)).toHaveLength(0);
  });

  it('a flash message shows once signed and is ignored when forged', async () => {
    const h = setup();
    const cookie = await h.login();
    const good = signToken({ uid: h.adminId, k: 'flash', e: 1, m: 'notice.noAccount' }, h.core.config.secret, 60);
    const ok = await request(h.app).get('/').query({ flash: good }).set('Host', h.host).set('Cookie', cookie);
    expect(ok.text).toContain(en('notice.noAccount'));
    const forged = await request(h.app).get('/').query({ flash: '<b>x</b>.AAAA' }).set('Host', h.host).set('Cookie', cookie);
    expect(forged.status).toBe(200);
    expect(forged.text).not.toContain('<b>x</b>');
    const other = signToken({ uid: 'someone-else', k: 'flash', e: 1, m: 'notice.noAccount' }, h.core.config.secret, 60);
    const foreign = await request(h.app).get('/').query({ flash: other }).set('Host', h.host).set('Cookie', cookie);
    expect(foreign.text).not.toContain(en('notice.noAccount'));
    const plain = signToken({ uid: h.adminId, k: 'flash', e: 1, m: 'Free text that is not a catalog key' }, h.core.config.secret, 60);
    expect((await request(h.app).get('/').query({ flash: plain }).set('Host', h.host).set('Cookie', cookie)).text).not.toContain('Free text');
  });

  it('serves the icon publicly', async () => {
    const h = setup();
    const res = await request(h.app).get('/icon.webp').set('Host', h.host);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toContain('max-age');
  });
});

describe('skill', () => {
  it('skill body equals guide', () => {
    const skill = fs.readFileSync(new URL('../skill/lager/SKILL.md', import.meta.url), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/^name: lager$/m);
    expect(m![1]).toMatch(/^description: .+/m);
    const guide = fs.readFileSync(new URL('../src/guide.md', import.meta.url), 'utf8');
    expect(skill.slice(m![0].length).trim()).toBe(guide.trim());
  });
});

describe('AI badge on app cards', () => {
  const cardOf = (html: string, slug: string): string => {
    const start = html.lastIndexOf('<article', html.indexOf(`<span class="slug">${slug}</span>`));
    return html.slice(start, html.indexOf('</article>', start));
  };

  it('marks apps whose version declares complete, on the home and the publish page', async () => {
    const hh = setup();
    hh.core.apps.deploy({ slug: 'plain', html: '<p>p</p>', userId: hh.adminId, capabilities: { db: {} } });
    hh.core.apps.deploy({ slug: 'smart', html: '<p>s</p>', userId: hh.adminId, capabilities: { db: {}, complete: {} } });
    const cookie = await hh.login();
    const home = (await get(hh, cookie)).text;
    expect(cardOf(home, 'smart')).toContain('class="ai-badge"');
    expect(cardOf(home, 'smart')).toContain(en('card.ai.hint'));
    expect(cardOf(home, 'plain')).not.toContain('ai-badge');
    const publish = (await get(hh, cookie, '/publish')).text;
    expect(cardOf(publish, 'smart')).toContain('class="ai-badge"');
    expect(cardOf(publish, 'plain')).not.toContain('ai-badge');
  });

  it('follows the version an instance runs, not the latest deploy', async () => {
    const hh = setup();
    const first = hh.core.apps.deploy({ slug: 'notes', html: '<p>1</p>', userId: hh.adminId, capabilities: { db: {} } });
    const pinned = hh.core.apps.createInstance({ appId: first.app.id, slug: 'notes-old', ownerId: hh.adminId });
    hh.core.apps.setAutoUpdate(pinned.id, false, hh.adminId);
    hh.core.apps.deploy({ slug: 'notes', html: '<p>2</p>', userId: hh.adminId, capabilities: { db: {}, complete: {} } });
    const home = (await get(hh, await hh.login())).text;
    expect(cardOf(home, 'notes')).toContain('class="ai-badge"');
    expect(cardOf(home, 'notes-old')).not.toContain('ai-badge');
  });
});
