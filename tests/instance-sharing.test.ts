import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfToken } from '../src/http/session.js';
import { t } from '../src/i18n/index.js';
import { showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const dom = (html: string): Document => new JSDOM(html).window.document;

describe('the instance page', () => {
  it('puts who may open the instance at the top of Sharing, before the people and groups', async () => {
    s = await showcase();
    const doc = dom((await request(s.h.app).get('/instances/notes').set('Host', s.h.host).set('Cookie', await s.h.login())).text);
    const sharing = doc.getElementById('sharing')!;
    const first = sharing.querySelector('form')!;
    expect(first.getAttribute('action')).toBe('/ui/instances/notes/visibility');
    expect(sharing.querySelector('h3')!.textContent).toBe(t('en', 'instance.grants.people'));
    // On a phone the Sharing card is the second card, right after the versions.
    expect([...doc.querySelectorAll('.main-col > section.card')].map((c) => c.id).slice(0, 2)).toEqual(['versions', 'sharing']);
  });

  it('the settings form refuses everyone who may not manage the instance, and changes nothing for them', async () => {
    s = await showcase();
    const { core } = s.h;
    const flags = (slug = 'notes') => { const i = core.apps.getInstanceBySlug(slug)!; return [i.autoUpdate, i.showBadge]; };
    const before = flags();
    const tasksBefore = flags('tasks');
    const post = (cookie: string, slug: string, csrf: string) =>
      request(s!.h.app).post(`/ui/instances/${slug}/settings`).set('Host', s!.h.host).set('Cookie', cookie).type('form').send({ csrf, auto_update: '0', badge: '0' });
    // Uwe may only view notes, and only use tasks.
    const uwe = await s.h.login('uwe@x.y', 'password-123');
    const uweCsrf = csrfToken(core, core.users.get(s.ids.uwe)!);
    expect((await post(uwe, 'notes', uweCsrf)).status).toBe(403);
    expect((await post(uwe, 'tasks', uweCsrf)).status).toBe(403);
    // Not signed in: to the sign-in page.
    const anonymous = await post('', 'notes', 'x');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toMatch(/^\/login/);
    // The owner, with a token from somewhere else.
    expect((await post(await s.h.login(), 'notes', 'stale')).status).toBe(403);
    expect(flags()).toEqual(before);
    expect(flags('tasks')).toEqual(tasksBefore);
  });

  it('a switch the form does not send stays as it is', async () => {
    s = await showcase();
    const { core } = s.h;
    const cookie = await s.h.login();
    const csrf = csrfToken(core, core.users.get(s.h.adminId)!);
    await request(s.h.app).post('/ui/instances/notes/settings').set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf, badge: '0' });
    expect([core.apps.getInstanceBySlug('notes')!.autoUpdate, core.apps.getInstanceBySlug('notes')!.showBadge]).toEqual([true, false]);
  });

  it('a manager refused updates for a version with other data rules keeps the badge change, and hears why', async () => {
    s = await showcase();
    const { core } = s.h;
    const admin = core.users.get(s.h.adminId)!;
    const notes = () => core.apps.getInstanceBySlug('notes')!;
    // The owner switches updates off; a new version without the endpoints arrives; Pia manages notes but does not own it.
    core.apps.setAutoUpdate(notes().id, false, admin.id);
    core.apps.deploy({ slug: 'notes', html: '<p>3</p>', userId: admin.id });
    core.access.setGrant(notes(), 'user', s.ids.pia, 'admin', admin);
    const pia = await s.h.login('pia@x.y', 'password-123');
    const res = await request(s.h.app).post('/ui/instances/notes/settings').set('Host', s.h.host).set('Cookie', pia).type('form')
      .send({ csrf: csrfToken(core, core.users.get(s.ids.pia)!), auto_update: ['0', '1'], badge: '0' });
    expect(res.status).toBe(302);
    expect([notes().autoUpdate, notes().showBadge, notes().activeVersion]).toEqual([false, false, 2]);
    const page = dom((await request(s.h.app).get(res.headers.location.split('#')[0]).set('Host', s.h.host).set('Cookie', pia)).text);
    expect(page.querySelector('.notice-danger')!.textContent).toContain(t('en', 'notice.rulesDiffer'));
  });

  it('keeps both switches with one Save, and names what changed', async () => {
    s = await showcase();
    const { core } = s.h;
    const cookie = await s.h.login();
    const csrf = csrfToken(core, core.users.get(s.h.adminId)!);
    const send = async (body: Record<string, string | string[]>): Promise<string> => {
      const res = await request(s!.h.app).post('/ui/instances/notes/settings').set('Host', s!.h.host).set('Cookie', cookie).type('form').send({ csrf, ...body });
      expect(res.status).toBe(302);
      const page = dom((await request(s!.h.app).get(res.headers.location.split('#')[0]).set('Host', s!.h.host).set('Cookie', cookie)).text);
      return page.querySelector('#notice > span')!.textContent!;
    };
    const notes = () => core.apps.getInstanceBySlug('notes')!;
    expect([notes().autoUpdate, notes().showBadge]).toEqual([true, true]);
    // Both changed with one press: both are kept.
    expect(await send({ auto_update: '0', badge: '0' })).toBe(t('en', 'notice.ok.saved'));
    expect([notes().autoUpdate, notes().showBadge]).toEqual([false, false]);
    expect(await send({ auto_update: '0', badge: ['0', '1'] })).toBe(t('en', 'notice.ok.badgeOn'));
    expect(await send({ auto_update: ['0', '1'], badge: ['0', '1'] })).toBe(t('en', 'notice.ok.autoUpdateOn', { version: String(notes().activeVersion) }));
    expect([notes().autoUpdate, notes().showBadge]).toEqual([true, true]);
  });

  it('marks the newest version and says when the next deploy moves a rolled-back instance forward', async () => {
    s = await showcase();
    const { core } = s.h;
    const cookie = await s.h.login();
    const html = async (): Promise<Document> => dom((await request(s!.h.app).get('/instances/notes').set('Host', s!.h.host).set('Cookie', cookie)).text);
    let doc = await html();
    expect(doc.querySelector('li[data-version="2"] .tl-title')!.textContent).toContain(t('en', 'instance.latest'));
    expect(doc.querySelector('li[data-version="1"] .tl-title')!.textContent).not.toContain(t('en', 'instance.latest'));
    expect(doc.querySelector('#versions .notice-warning')).toBeNull();
    // Back to version 1 with updates still on.
    core.apps.activate(core.apps.getInstanceBySlug('notes')!.id, 1, s.h.adminId);
    doc = await html();
    expect(doc.querySelector('#versions .notice-warning')!.textContent).toContain(t('en', 'instance.behind', { latest: 2, active: 1 }));
    // With updates off it stays on version 1, and there is nothing to warn about.
    core.apps.setAutoUpdate(core.apps.getInstanceBySlug('notes')!.id, false, s.h.adminId);
    expect((await html()).querySelector('#versions .notice-warning')).toBeNull();
  });
});

describe('sharing', () => {
  it('offers a form for a person and, where there are groups, one for a group; the app address can be copied', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const doc = dom((await request(s.h.app).get('/instances/notes').set('Host', s.h.host).set('Cookie', cookie)).text);
    const forms = [...doc.querySelectorAll('#sharing form[action="/ui/instances/notes/grants"]')].filter((f) => !f.classList.contains('inline-form'));
    expect(forms.map((f) => [...f.querySelectorAll('input[name="email"], select[name="group"]')].map((e) => e.getAttribute('name')))).toEqual([['email'], ['group']]);
    // The header offers the address to copy next to Open.
    const copy = doc.querySelector('.hero-actions [data-copy]')!;
    expect(copy.getAttribute('data-copy')).toBe('http://notes.apps.localhost:8080');
    expect(copy.textContent).toBe(t('en', 'instance.copyLink'));
    // Sharing ends with the address to send, ready to copy.
    const csrf = csrfToken(s.h.core, s.h.core.users.get(s.h.adminId)!);
    const res = await request(s.h.app).post('/ui/instances/notes/grants').set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf, email: 'pia@x.y', level: 'view' });
    const after = dom((await request(s.h.app).get(res.headers.location.split('#')[0]).set('Host', s.h.host).set('Cookie', cookie)).text);
    expect(after.querySelector('#notice [data-copy]')!.getAttribute('data-copy')).toBe('http://notes.apps.localhost:8080');
  });

  it('has no group form on a server without groups', async () => {
    s = await showcase();
    s.h.core.groups.delete(s.ids.group);
    const doc = dom((await request(s.h.app).get('/instances/notes').set('Host', s.h.host).set('Cookie', await s.h.login())).text);
    expect(doc.querySelector('#sharing select[name="group"]')).toBeNull();
  });
});

describe('the home page of someone who does not publish', () => {
  it('speaks of apps and copies, says whose a shared app is, and shows no badges only a manager can act on', async () => {
    s = await showcase();
    const { core } = s.h;
    const cookie = await s.h.login('uwe@x.y', 'password-123');
    core.apps.createInstance({ appId: core.apps.getApp('tasks')!.id, slug: 'uwe-tasks', ownerId: s.ids.uwe });
    const html = (await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', cookie)).text;
    const main = dom(html).querySelector('main')!;
    expect(main.textContent!.toLowerCase()).not.toContain('instance');
    const shared = main.querySelector('#shared')!;
    const card = [...shared.querySelectorAll('.app-card')].find((c) => c.textContent!.includes('notes'))!;
    const badges = [...card.querySelectorAll('.badge-text')].map((b) => b.textContent);
    // Uwe reaches it as a viewer himself and as a contributor through his group: the higher level counts.
    const owner = core.users.get(s.h.adminId)!;
    expect(badges).toEqual([t('en', 'badge.shared', { level: t('en', 'level.interact') }), owner.name]);
    // The catalog says how many copies of an app the viewer already has.
    const catalog = dom((await request(s.h.app).get('/catalog').set('Host', s.h.host).set('Cookie', cookie)).text).querySelector('main')!;
    expect(catalog.textContent!.toLowerCase()).not.toContain('instance');
    const tasks = [...catalog.querySelectorAll('#catalog .app-card')].find((c) => c.querySelector('details.getown') && c.textContent!.includes('tasks'))!;
    expect(tasks.textContent).toContain(t('en', 'dash.copies.one'));
  });

  const cardOn = async (sc: Showcase, cookie: string, section: string, slug: string): Promise<string[]> => {
    const main = dom((await request(sc.h.app).get('/').set('Host', sc.h.host).set('Cookie', cookie)).text).querySelector('main')!;
    const card = [...main.querySelectorAll(`#${section} .app-card`)].find((c) => c.querySelector(`a[href="/instances/${slug}"]`) || c.textContent!.includes(slug))!;
    return [...card.querySelectorAll('.badge-text')].map((b) => b.textContent!);
  };

  it('shows visibility and version on a shared card to someone who may manage it, and only "Disabled" on a disabled own one', async () => {
    s = await showcase();
    const { core } = s.h;
    const tasks = core.apps.getInstanceBySlug('tasks')!;
    core.access.setGrant(tasks, 'user', s.ids.uwe, 'admin', core.users.get(s.ids.pia)!);
    const cookie = await s.h.login('uwe@x.y', 'password-123');
    expect(await cardOn(s, cookie, 'shared', 'tasks')).toEqual([
      t('en', 'visibility.users'), `v${tasks.activeVersion}`,
      t('en', 'badge.shared', { level: t('en', 'level.admin') }), 'Pia Publisher',
    ]);
    const own = core.apps.createInstance({ appId: core.apps.getApp('tasks')!.id, slug: 'uwe-tasks', ownerId: s.ids.uwe });
    core.apps.setInstanceDisabled(own.id, true);
    expect(await cardOn(s, cookie, 'mine', 'uwe-tasks')).toEqual([t('en', 'common.disabled')]);
  });

  it('shows "–" for an owner without a name, never the address', async () => {
    s = await showcase();
    const { core } = s.h;
    (core.users as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare("UPDATE users SET name = '' WHERE id = ?").run(s.h.adminId);
    const cookie = await s.h.login('uwe@x.y', 'password-123');
    const badges = await cardOn(s, cookie, 'shared', 'notes');
    expect(badges.at(-1)).toBe('–');
    expect(badges.join(' ')).not.toContain(core.users.get(s.h.adminId)!.email);
  });
});

describe('sharing with an address that has no account', () => {
  it('tells a publisher on a server with open registration that the person can sign up themselves', async () => {
    s = await showcase();
    const { core } = s.h;
    const cookie = await s.h.login('pia@x.y', 'password-123');
    const csrf = csrfToken(core, core.users.get(s.ids.pia)!);
    const res = await request(s.h.app).post('/ui/instances/tasks/grants').set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf, email: 'nobody@x.y', level: 'view' });
    expect(res.status).toBe(302);
    const doc = dom((await request(s.h.app).get(res.headers.location.split('#')[0]).set('Host', s.h.host).set('Cookie', cookie)).text);
    expect(doc.getElementById('grant-email-error')!.textContent).toBe(t('en', 'notice.noAccount.open'));
  });
});

describe('app cards', () => {
  it('link the whole card through the title, once, and leave Manage its own target', async () => {
    s = await showcase();
    const doc = dom((await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', await s.h.login())).text);
    const card = [...doc.querySelectorAll('#mine .app-card')].find((c) => c.querySelector('.slug')!.textContent === 'notes')!;
    const link = card.querySelector('h3 a.card-link')!;
    expect(link.getAttribute('href')).toBe('http://notes.apps.localhost:8080');
    expect(link.getAttribute('aria-label')).toBe(t('en', 'card.open', { title: 'Notes' }));
    // The visible Open button repeats the link but is neither tabbed to nor read out a second time.
    const open = card.querySelector('.card-actions a[href="http://notes.apps.localhost:8080"]')!;
    expect([open.getAttribute('tabindex'), open.getAttribute('aria-hidden')]).toEqual(['-1', 'true']);
    const reachable = [...card.querySelectorAll('a, button, summary')].filter((e) => e.getAttribute('tabindex') !== '-1').map((e) => e.getAttribute('href'));
    expect(reachable).toEqual(['http://notes.apps.localhost:8080', '/instances/notes']);
    // A disabled instance and an app one can only get a copy of are not links.
    expect([...doc.querySelectorAll('#mine .app-card')].find((c) => c.querySelector('.slug')!.textContent === 'old-notes')!.querySelector('.card-link')).toBeNull();
    const catalog = dom((await request(s.h.app).get('/catalog').set('Host', s.h.host).set('Cookie', await s.h.login())).text);
    expect(catalog.querySelectorAll('#catalog .app-card').length).toBeGreaterThan(0);
    for (const c of catalog.querySelectorAll('#catalog .app-card')) if (c.querySelector('details.getown')) expect(c.querySelector('.card-link')).toBeNull();
  });

  /** The card link of the card for `slug` in `section`, and the targets the keyboard reaches on that card, in order. */
  const linkOf = (doc: Document, section: string, slug: string) => {
    const card = [...doc.querySelectorAll(`#${section} .app-card`)].find((c) => c.querySelector('.slug')!.textContent === slug)!;
    const link = card.querySelector('h3 a.card-link');
    const repeated = [...card.querySelectorAll('.card-actions a[tabindex="-1"]')].map((a) => [a.getAttribute('href'), a.getAttribute('aria-hidden')]);
    const reachable = [...card.querySelectorAll('a, button, summary')].filter((e) => e.getAttribute('tabindex') !== '-1').map((e) => e.getAttribute('href'));
    return { href: link?.getAttribute('href'), label: link?.getAttribute('aria-label'), repeated, reachable };
  };
  const page = async (path: string, email: string): Promise<Document> =>
    dom((await request(s!.h.app).get(path).set('Host', s!.h.host).set('Cookie', await s!.h.login(email, 'password-123'))).text);

  it('link a shared card to the app, with Manage only for those who may manage it', async () => {
    s = await showcase();
    const tasks = 'http://tasks.apps.localhost:8080';
    // Uwe has notes to view and use: the app is the card's one target.
    expect(linkOf(await page('/', 'uwe@x.y'), 'shared', 'notes')).toEqual({
      href: 'http://notes.apps.localhost:8080', label: t('en', 'card.open', { title: 'Notes' }),
      repeated: [['http://notes.apps.localhost:8080', 'true']], reachable: ['http://notes.apps.localhost:8080'],
    });
    // As a manager of tasks, the app and then Manage.
    s.h.core.access.setGrant(s.h.core.apps.getInstanceBySlug('tasks')!, 'user', s.ids.uwe, 'admin', s.h.core.users.get(s.ids.pia)!);
    expect(linkOf(await page('/', 'uwe@x.y'), 'shared', 'tasks')).toMatchObject({ href: tasks, reachable: [tasks, '/instances/tasks'] });
  });

  it('link an instance in the catalog to it, and an app under Publish to its page', async () => {
    s = await showcase();
    const { core } = s.h;
    // Tasks is open to everyone signed in; Cleo has no grant, so it is in her catalog.
    core.users.create({ email: 'cleo@x.y', name: 'Cleo', password: 'password-123', role: 'user' });
    expect(linkOf(await page('/catalog', 'cleo@x.y'), 'catalog', 'tasks')).toEqual({
      href: 'http://tasks.apps.localhost:8080', label: t('en', 'card.open', { title: 'Tasks' }),
      repeated: [['http://tasks.apps.localhost:8080', 'true']], reachable: ['http://tasks.apps.localhost:8080'],
    });
    expect(linkOf(await page('/publish', 'pia@x.y'), 'apps', 'tasks')).toEqual({
      href: '/apps/tasks', label: t('en', 'card.manage', { title: 'Tasks' }), repeated: [['/apps/tasks', 'true']], reachable: ['/apps/tasks'],
    });
  });

  it('do not lift on a phone or for those who asked for less motion, though linked cards lift elsewhere', () => {
    const css = fs.readFileSync(new URL('../src/static/app.css', import.meta.url), 'utf8');
    const block = (query: string): string => { const at = css.indexOf(query); return css.slice(at, css.indexOf('\n}', at)); };
    expect(css).toContain('.app-card.is-linked:hover { transform: translateY(-2px);');
    // The overrides must be at least as specific as the rule that lifts.
    for (const query of ['@media (max-width: 520px)', '@media (prefers-reduced-motion: reduce)']) expect(block(query)).toContain('.app-card.is-linked:hover { transform: none; }');
  });
});
