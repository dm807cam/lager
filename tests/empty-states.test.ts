import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { t, type Locale, type MessageKey } from '../src/i18n/index.js';
import { PASSWORD, showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const dom = (html: string): Document => new JSDOM(html).window.document;

async function page(sc: Showcase, path: string, email?: string, locale: Locale = 'en'): Promise<Document> {
  const cookie = email ? await sc.h.login(email, PASSWORD) : await sc.h.login();
  return dom((await request(sc.h.app).get(path).set('Host', sc.h.host).set('Cookie', `${cookie}; lager_lang=${locale}`)).text);
}

/** An empty state as the viewer reads it: what is missing, the sentence after it, and where its buttons lead. */
function empty(root: ParentNode | null) {
  const box = root?.querySelector('.empty');
  if (!box) return null;
  return {
    text: box.querySelector('p')!.textContent,
    detail: box.querySelector('.empty-detail')?.textContent ?? null,
    links: [...box.querySelectorAll('.empty-actions a')].map((a) => [a.getAttribute('href'), a.classList.contains('btn-primary') ? 'primary' : 'secondary']),
  };
}

describe('empty states say what to do next', () => {
  it('on the home page, someone without an app of their own is sent to the catalog, and a publisher to Publish as well', async () => {
    s = await showcase();
    const { core } = s.h;
    // Uwe has no app of his own; the catalog offers Tasks.
    expect(empty((await page(s, '/', 'uwe@x.y')).getElementById('mine'))).toEqual({
      text: t('en', 'dash.noInstances'), detail: t('en', 'home.empty.catalog'), links: [['/catalog', 'primary']],
    });
    core.users.create({ email: 'paul@x.y', name: 'Paul', password: PASSWORD, role: 'publisher' });
    expect(empty((await page(s, '/', 'paul@x.y', 'de')).getElementById('mine'))).toEqual({
      text: t('de', 'dash.noInstances'), detail: t('de', 'home.empty.catalogPublish'), links: [['/catalog', 'primary'], ['/publish', 'secondary']],
    });
    // Without a catalog, a publisher publishes and anyone else waits for a share.
    const tasks = core.apps.getInstanceBySlug('tasks')!;
    core.apps.setSelfInstances(tasks.appId, 'off', s.ids.pia);
    core.apps.setVisibility(tasks.id, 'private', s.ids.pia);
    core.access.setGrant(core.apps.getInstanceBySlug('notes')!, 'user', core.users.getByEmail('paul@x.y')!.id, 'view', core.users.get(s.h.adminId)!);
    expect(empty((await page(s, '/', 'paul@x.y')).getElementById('mine'))).toEqual({
      text: t('en', 'dash.noInstances'), detail: t('en', 'home.empty.publish'), links: [['/publish', 'primary']],
    });
    expect(empty((await page(s, '/', 'uwe@x.y')).getElementById('mine'))).toEqual({ text: t('en', 'dash.noInstances'), detail: t('en', 'home.empty.user'), links: [] });
  });

  it('an instance shared with nobody says who can open it now, by its visibility', async () => {
    s = await showcase();
    const { core } = s.h;
    const fresh = core.apps.createInstance({ appId: core.apps.getApp('notes')!.id, slug: 'fresh', ownerId: s.h.adminId });
    const cases: Array<['private' | 'users' | 'public', MessageKey]> = [
      ['private', 'instance.grants.none.private'], ['users', 'instance.grants.none.users'], ['public', 'instance.grants.none.public'],
    ];
    for (const [visibility, key] of cases) {
      core.apps.setVisibility(fresh.id, visibility, s.h.adminId);
      expect(empty((await page(s, '/instances/fresh')).getElementById('sharing'))?.detail, visibility).toBe(t('en', key));
    }
    // A new instance has no snapshot yet: the page says when one is taken.
    expect(empty((await page(s, '/instances/fresh', undefined, 'fr')).getElementById('data'))?.detail).toBe(t('fr', 'instance.snapshots.none.detail'));
  });

  it('tokens, collaborators and groups say what they are for', async () => {
    s = await showcase();
    expect(empty((await page(s, '/publish', 'pia@x.y')).getElementById('tokens'))?.detail).toBe(t('en', 'dash.tokens.none.detail'));
    expect(empty((await page(s, '/apps/tasks', 'pia@x.y', 'es')).getElementById('collaborators'))?.detail).toBe(t('es', 'app.noCollaborators.detail'));
    s.h.core.groups.delete(s.ids.group);
    expect(empty((await page(s, '/admin/groups', undefined, 'de')).querySelector('main'))?.detail).toBe(t('de', 'admin.groups.none.detail'));
  });
});
