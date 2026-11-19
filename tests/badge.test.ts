import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { apiExtension } from '../src/http/api.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { PROJECT_URL } from '../src/http/instance.js';
import { csrfToken } from '../src/http/session.js';
import { signToken } from '../src/http/tokens.js';
import { t } from '../src/i18n/index.js';
import type { GrantLevel } from '../src/platform/access.js';
import { makeHarness, type Harness } from './support/http.js';

const W = 'notes.apps.localhost';
let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

function setup() {
  h = makeHarness({ extensions: [adminExtension, dashboardExtension, manageExtension, apiExtension] });
  const hh = h;
  const inst = hh.core.apps.deploy({ slug: 'notes', html: '<!doctype html><html><head></head><body><p>hi</p></body></html>', userId: hh.adminId }).instances[0];
  const admin = hh.core.users.get(hh.adminId)!;
  const cookieFor = (userId: string) => 'lager_inst=' + signToken({ uid: userId, iid: inst.id, k: 'inst', ep: 0 }, 'test-secret', 600);
  const withGrant = (email: string, level: GrantLevel) => {
    const u = hh.core.users.create({ email, name: email, password: 'pw-12345678', role: 'user' });
    hh.core.access.setGrant(inst, 'user', u.id, level, admin);
    return cookieFor(u.id);
  };
  const page = (cookie?: string, lang = 'en') => {
    const r = request(hh.app).get('/').set('Host', W).set('Accept-Language', lang);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  return { hh, inst, admin, owner: cookieFor(hh.adminId), withGrant, page };
}

const hasBadge = (html: string): boolean => html.includes('<script src="/__lager/badge.js"');

describe('"Made with Lager" badge', () => {
  it('is shown to the people an instance is shared with, never to its owner and managers', async () => {
    const s = setup();
    expect(hasBadge((await s.page(s.owner)).text)).toBe(false);
    expect(hasBadge((await s.page(s.withGrant('manager@x.y', 'admin'))).text)).toBe(false);
    const viewer = (await s.page(s.withGrant('viewer@x.y', 'view'))).text;
    expect(hasBadge(viewer)).toBe(true);
    expect(viewer).toContain(`data-label="${t('en', 'badge.label')}"`);
    expect(viewer).toContain(`data-href="${PROJECT_URL}"`);
    expect(hasBadge((await s.page(s.withGrant('helper@x.y', 'interact'))).text)).toBe(true);
  });

  it('is shown to anonymous visitors of a public instance, in their language', async () => {
    const s = setup();
    s.hh.core.apps.setVisibility(s.inst.id, 'public', s.hh.adminId);
    const de = (await s.page(undefined, 'de')).text;
    expect(hasBadge(de)).toBe(true);
    expect(de).toContain('data-label="Gebaut mit Lager"');
    expect(de).toContain(`data-close="${t('de', 'badge.close')}"`);
    // The tag sits in the head, after the runtime, and the app's own markup is untouched.
    expect(de.indexOf('/__lager/runtime.js')).toBeLessThan(de.indexOf('/__lager/badge.js'));
    expect(de).toContain('<body><p>hi</p></body>');
  });

  it('the instance setting turns it off, for managers only', async () => {
    const s = setup();
    const viewer = s.withGrant('viewer@x.y', 'view');
    const token = s.hh.core.tokens.create(s.hh.adminId, 'test').token;
    const off = await request(s.hh.app).post('/api/instances/notes/badge').set('Host', s.hh.host)
      .set('Authorization', `Bearer ${token}`).send({ on: false });
    expect(off.status).toBe(200);
    expect(off.body.showBadge).toBe(false);
    expect(hasBadge((await s.page(viewer)).text)).toBe(false);
    const bad = await request(s.hh.app).post('/api/instances/notes/badge').set('Host', s.hh.host)
      .set('Authorization', `Bearer ${token}`).send({ on: 'no' });
    expect(bad.status).toBe(400);
    // Someone who may only view cannot change it.
    const stranger = s.hh.core.users.create({ email: 'pub@x.y', name: 'P', password: 'pw-12345678', role: 'publisher' });
    const strangerToken = s.hh.core.tokens.create(stranger.id, 'test').token;
    const denied = await request(s.hh.app).post('/api/instances/notes/badge').set('Host', s.hh.host)
      .set('Authorization', `Bearer ${strangerToken}`).send({ on: true });
    expect(denied.status).toBeGreaterThanOrEqual(403);
    expect(s.hh.core.apps.getInstance(s.inst.id)!.showBadge).toBe(false);
  });

  it('the dashboard switch on the instance page changes it', async () => {
    const s = setup();
    const cookie = await s.hh.login();
    const pageHtml = (await request(s.hh.app).get('/instances/notes').set('Host', s.hh.host).set('Cookie', cookie)).text;
    expect(pageHtml).toContain('action="/ui/instances/notes/badge"');
    const res = await request(s.hh.app).post('/ui/instances/notes/badge').set('Host', s.hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.hh.core, s.admin), on: '0' });
    expect(res.status).toBe(302);
    expect(s.hh.core.apps.getInstance(s.inst.id)!.showBadge).toBe(false);
    await request(s.hh.app).post('/ui/instances/notes/badge').set('Host', s.hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.hh.core, s.admin), on: ['0', '1'] });
    expect(s.hh.core.apps.getInstance(s.inst.id)!.showBadge).toBe(true);
  });

  it('the server setting turns it off everywhere and hides the instance switch', async () => {
    const s = setup();
    const viewer = s.withGrant('viewer@x.y', 'view');
    const cookie = await s.hh.login();
    const settings = (await request(s.hh.app).get('/admin/settings').set('Host', s.hh.host).set('Cookie', cookie)).text;
    expect(settings).toContain('id="made-with-badge"');
    const post = (body: Record<string, unknown>) => request(s.hh.app).post('/admin/settings').set('Host', s.hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.hh.core, s.admin), registration: 'invite', maxInstances: '20', ...body });
    expect((await post({ madeWithBadge: '0' })).status).toBe(302);
    expect(s.hh.core.settings.madeWithBadge).toBe(false);
    expect(hasBadge((await s.page(viewer)).text)).toBe(false);
    const instancePage = (await request(s.hh.app).get('/instances/notes').set('Host', s.hh.host).set('Cookie', cookie)).text;
    expect(instancePage).not.toContain('action="/ui/instances/notes/badge"');
    // A form without the field leaves the setting alone; ticking it turns it back on.
    await post({});
    expect(s.hh.core.settings.madeWithBadge).toBe(false);
    await post({ madeWithBadge: ['0', '1'] });
    expect(s.hh.core.settings.madeWithBadge).toBe(true);
    expect(hasBadge((await s.page(viewer)).text)).toBe(true);
  });

  it('serves the badge script with a validator', async () => {
    const s = setup();
    const res = await request(s.hh.app).get('/__lager/badge.js').set('Host', W);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    const again = await request(s.hh.app).get('/__lager/badge.js').set('Host', W).set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);
  });
});
