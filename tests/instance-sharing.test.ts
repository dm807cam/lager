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
