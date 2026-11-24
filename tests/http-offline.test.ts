import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { checkCapabilities } from '../src/mcp/tools.js';
import { offlineAllowed } from '../src/http/instance.js';
import { signToken } from '../src/http/tokens.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const W = 'workout.apps.localhost';

function setup(caps?: object, visibility?: 'private' | 'public') {
  h = makeHarness();
  const r = h.core.apps.deploy({ slug: 'workout', html: '<html><head></head><body>v1</body></html>', userId: h.adminId, capabilities: caps });
  if (visibility) h.core.apps.setVisibility(r.instances[0].id, visibility, h.adminId);
  return { h, inst: r.instances[0] };
}

describe('offline: the service worker script', () => {
  it('is served with its type, an ETag and the header that lets it control the whole host', async () => {
    const { h } = setup();
    const res = await request(h.app).get('/__lager/sw.js').set('Host', W);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['service-worker-allowed']).toBe('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain("var CACHE = 'lager-offline-1';");
    expect((await request(h.app).get('/__lager/sw.js').set('Host', W).set('If-None-Match', res.headers.etag)).status).toBe(304);
  });

  it('needs no sign-in, as the browser checks it for updates by itself, but an unknown or disabled instance has none', async () => {
    const { h, inst } = setup();
    expect((await request(h.app).get('/__lager/sw.js').set('Host', W)).status).toBe(200);
    expect((await request(h.app).get('/__lager/sw.js').set('Host', 'nothing.apps.localhost')).status).toBe(404);
    h.core.apps.setInstanceDisabled(inst.id, true);
    expect((await request(h.app).get('/__lager/sw.js').set('Host', W)).status).toBe(403);
  });
});

describe('offline: what the server marks for keeping', () => {
  it('marks the page and the session of a viewer with access', async () => {
    const { h } = setup();
    const cookie = await h.enter('workout', await h.login());
    const page = await request(h.app).get('/').set('Host', W).set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.headers['x-lager-offline']).toBe('1');
    // The browser's own cache still keeps nothing: only the service worker does, and it deletes what it kept when access ends.
    expect(page.headers['cache-control']).toBe('no-store');
    const session = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie);
    expect(session.headers['x-lager-offline']).toBe('1');
  });

  it('marks the page of a public instance for guests as well', async () => {
    const { h } = setup(undefined, 'public');
    expect((await request(h.app).get('/').set('Host', W)).headers['x-lager-offline']).toBe('1');
    expect((await request(h.app).get('/__lager/session').set('Host', W)).headers['x-lager-offline']).toBe('1');
  });

  it('never marks a redirect to the sign-in, a refusal or a disabled instance', async () => {
    const { h, inst } = setup();
    const anonymous = await request(h.app).get('/').set('Host', W);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers['x-lager-offline']).toBeUndefined();
    expect((await request(h.app).get('/__lager/session').set('Host', W)).headers['x-lager-offline']).toBeUndefined();

    const u = h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
    const stranger = 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst', ep: 0 }, 'test-secret', 60);
    const refused = await request(h.app).get('/').set('Host', W).set('Cookie', stranger);
    expect(refused.status).toBe(403);
    expect(refused.headers['x-lager-offline']).toBeUndefined();

    const owner = await h.enter('workout', await h.login());
    h.core.apps.setInstanceDisabled(inst.id, true);
    const disabled = await request(h.app).get('/').set('Host', W).set('Cookie', owner);
    expect(disabled.status).toBe(403);
    expect(disabled.headers['x-lager-offline']).toBeUndefined();
  });

  it('marks nothing for a session that ended: after a sign-out or a password change, or for a signed-in stranger', async () => {
    const { h, inst } = setup();
    const cookie = await h.enter('workout', await h.login());
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', cookie)).headers['x-lager-offline']).toBe('1');
    // Sign-out and a password change move the epoch on: the cookie from before is worth nothing.
    h.core.users.bumpEpoch(h.adminId);
    const page = await request(h.app).get('/').set('Host', W).set('Cookie', cookie);
    expect(page.status).toBe(302);
    expect(page.headers['x-lager-offline']).toBeUndefined();
    const session = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie);
    expect(session.status).toBe(401);
    expect(session.headers['x-lager-offline']).toBeUndefined();

    const u = h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
    const stranger = 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst', ep: 0 }, 'test-secret', 60);
    const refused = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', stranger);
    expect(refused.status).toBe(401);
    expect(refused.headers['x-lager-offline']).toBeUndefined();
  });

  it('marks nothing for an app that declares {"db": {"offline": false}}, and follows the active version', async () => {
    const { h, inst } = setup({ db: { offline: false } });
    const cookie = await h.enter('workout', await h.login());
    const page = await request(h.app).get('/').set('Host', W).set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.headers['x-lager-offline']).toBeUndefined();
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).headers['x-lager-offline']).toBeUndefined();

    h.core.apps.deploy({ slug: 'workout', html: '<html><head></head><body>v2</body></html>', userId: h.adminId, capabilities: { db: {} } });
    expect(h.core.apps.getInstance(inst.id)!.activeVersion).toBe(2);
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', cookie)).headers['x-lager-offline']).toBe('1');
  });
});

describe('offline: the declaration', () => {
  it('is on unless db.offline is false', () => {
    expect(offlineAllowed({})).toBe(true);
    expect(offlineAllowed({ db: {} })).toBe(true);
    expect(offlineAllowed({ db: { offline: true } })).toBe(true);
    expect(offlineAllowed({ db: { offline: false, rules: [] } })).toBe(false);
  });

  it('db.offline must be true or false', () => {
    expect(checkCapabilities({ db: { offline: false } })).toEqual({ db: { offline: false } });
    expect(checkCapabilities({ db: { offline: true, rules: [{ path: 'a/{id}', read: 'view' }] } })).toBeTruthy();
    for (const bad of ['no', 0, null, {}]) expect(() => checkCapabilities({ db: { offline: bad } })).toThrow(/db\.offline must be true or false/);
  });
});
