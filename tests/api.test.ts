import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { apiExtension } from '../src/http/api.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

function setup(): { h: Harness; token: string } {
  h = makeHarness({ extensions: [apiExtension] });
  return { h, token: h.core.tokens.create(h.adminId, 'test').token };
}

describe('rest api', () => {
  it('PUT text/html deploys and returns the url', async () => {
    const { h, token } = setup();
    const res = await request(h.app).put('/api/apps/workout').query({ title: 'Workout', note: 'first' })
      .set('Host', h.host).set('Authorization', `Bearer ${token}`).type('text/html').send('<h1>Hi</h1>');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      app: 'workout', version: 1, createdVersion: true, urls: ['http://workout.apps.localhost:8080'], warnings: [],
    });
    expect(res.body.urls[0]).toBe('http://workout.apps.localhost:8080');
    const app = h.core.apps.getApp('workout')!;
    expect(app.title).toBe('Workout');
    expect(h.core.apps.listVersions(app.id)[0].note).toBe('first');
    expect(h.core.apps.readVersionHtml(app.id, 1)).toBe('<h1>Hi</h1>');
  });

  it('PUT text/html takes capabilities as a JSON query param', async () => {
    const { h, token } = setup();
    const res = await request(h.app).put('/api/apps/workout').query({ capabilities: JSON.stringify({ db: {} }) })
      .set('Host', h.host).set('Authorization', `Bearer ${token}`).type('text/html').send('<p>x</p>');
    expect(res.status).toBe(200);
    expect(h.core.apps.listVersions(h.core.apps.getApp('workout')!.id)[0].capabilities).toEqual({ db: {} });
    const bad = await request(h.app).put('/api/apps/workout').query({ capabilities: '{nope' })
      .set('Host', h.host).set('Authorization', `Bearer ${token}`).type('text/html').send('<p>y</p>');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_argument');
  });

  it('PUT application/json with capabilities', async () => {
    const { h, token } = setup();
    const caps = { db: { rules: [{ path: 'votes', write: 'owner' }] }, user: {} };
    const res = await request(h.app).put('/api/apps/poll').set('Host', h.host).set('Authorization', `Bearer ${token}`)
      .send({ html: '<script>localStorage.x=1</script>', title: 'Poll', capabilities: caps, note: 'n' });
    expect(res.status).toBe(200);
    expect(res.body.app).toBe('poll');
    expect(res.body.createdVersion).toBe(true);
    expect(res.body.warnings).toHaveLength(1);
    expect(h.core.apps.listVersions(h.core.apps.getApp('poll')!.id)[0].capabilities).toEqual(caps);

    const again = await request(h.app).put('/api/apps/poll').set('Host', h.host).set('Authorization', `Bearer ${token}`)
      .send({ html: '<script>localStorage.x=1</script>', capabilities: caps });
    expect(again.body).toMatchObject({ version: 1, createdVersion: false });

    const bad = await request(h.app).put('/api/apps/poll').set('Host', h.host).set('Authorization', `Bearer ${token}`)
      .send({ html: 5 });
    expect(bad.status).toBe(400);
  });

  it('no auth → 401; bad token → 401', async () => {
    const { h } = setup();
    const none = await request(h.app).get('/api/apps').set('Host', h.host);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('unauthenticated');
    const bad = await request(h.app).get('/api/apps').set('Host', h.host).set('Authorization', 'Bearer lgr_nope');
    expect(bad.status).toBe(401);
    const badOauth = await request(h.app).get('/api/apps').set('Host', h.host).set('Authorization', 'Bearer something');
    expect(badOauth.status).toBe(401);
    const basic = await request(h.app).get('/api/apps').set('Host', h.host).set('Authorization', 'Basic eDp5');
    expect(basic.status).toBe(401);
  });

  it('cookie without X-Lager-Request → 401', async () => {
    const { h } = setup();
    const cookie = await h.login();
    const without = await request(h.app).get('/api/apps').set('Host', h.host).set('Cookie', cookie);
    expect(without.status).toBe(401);
    const withHeader = await request(h.app).get('/api/apps').set('Host', h.host).set('Cookie', cookie).set('X-Lager-Request', '1');
    expect(withHeader.status).toBe(200);
  });

  it('GET /api/apps lists only own apps', async () => {
    const { h, token } = setup();
    const other = h.core.users.create({ email: 'p@x.y', name: 'P', password: 'pw2', role: 'publisher' });
    h.core.apps.deploy({ slug: 'mine', html: '<p>m</p>', title: 'Mine', userId: h.adminId });
    h.core.apps.deploy({ slug: 'mine', html: '<p>m2</p>', userId: h.adminId });
    h.core.apps.deploy({ slug: 'theirs', html: '<p>t</p>', userId: other.id });
    const res = await request(h.app).get('/api/apps').set('Host', h.host).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      apps: [{
        slug: 'mine', title: 'Mine', latestVersion: 2,
        instances: [{ slug: 'mine', url: 'http://mine.apps.localhost:8080', activeVersion: 2, visibility: 'private' }],
      }],
    });

    const one = await request(h.app).get('/api/apps/mine').set('Host', h.host).set('Authorization', `Bearer ${token}`);
    expect(one.status).toBe(200);
    expect(one.body.slug).toBe('mine');
    expect(one.body.versions.map((v: { number: number }) => v.number)).toEqual([1, 2]);
    expect(Object.keys(one.body.versions[0]).sort()).toEqual(['createdAt', 'note', 'number', 'sizeBytes']);

    const foreign = await request(h.app).get('/api/apps/theirs').set('Host', h.host).set('Authorization', `Bearer ${token}`);
    expect(foreign.status).toBe(403);
    const missing = await request(h.app).get('/api/apps/nothing').set('Host', h.host).set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });

  it('activate over REST', async () => {
    const { h, token } = setup();
    h.core.apps.deploy({ slug: 'todo', html: '<p>1</p>', userId: h.adminId });
    h.core.apps.deploy({ slug: 'todo', html: '<p>2</p>', userId: h.adminId });
    const res = await request(h.app).post('/api/instances/todo/activate').set('Host', h.host)
      .set('Authorization', `Bearer ${token}`).send({ version: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: 'todo', url: 'http://todo.apps.localhost:8080', activeVersion: 1, visibility: 'private' });
    expect(h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(1);
    const bad = await request(h.app).post('/api/instances/todo/activate').set('Host', h.host)
      .set('Authorization', `Bearer ${token}`).send({ version: 9 });
    expect(bad.status).toBe(404);
  });

  it('GET /api/apps/:slug allows a collaborator and refuses an unrelated user', async () => {
    const { h } = setup();
    const collab = h.core.users.create({ email: 'c@x.y', name: 'C', password: 'pw-collab-1', role: 'publisher' });
    const stranger = h.core.users.create({ email: 's@x.y', name: 'S', password: 'pw-stranger-1', role: 'publisher' });
    const app = h.core.apps.deploy({ slug: 'shared', html: '<p>s</p>', userId: h.adminId }).app;
    h.core.apps.addCollaborator(app.id, collab.id, h.adminId);
    const get = (u: { id: string }) => request(h.app).get('/api/apps/shared').set('Host', h.host)
      .set('Authorization', `Bearer ${h.core.tokens.create(u.id, 't').token}`);
    const ok = await get(collab);
    expect(ok.status).toBe(200);
    expect(ok.body.slug).toBe('shared');
    const no = await get(stranger);
    expect(no.status).toBe(403);
    expect(no.body.error.code).toBe('forbidden');
  });

  it('activate over REST needs an instance admin grant; interact is refused', async () => {
    const { h } = setup();
    const adm = h.core.users.create({ email: 'a@x.y', name: 'A', password: 'pw-admin-grant', role: 'user' });
    const act = h.core.users.create({ email: 'i@x.y', name: 'I', password: 'pw-interact-1', role: 'user' });
    h.core.apps.deploy({ slug: 'todo', html: '<p>1</p>', userId: h.adminId });
    h.core.apps.deploy({ slug: 'todo', html: '<p>2</p>', userId: h.adminId });
    const inst = h.core.apps.getInstanceBySlug('todo')!;
    const owner = h.core.users.get(h.adminId)!;
    h.core.access.setGrant(inst, 'user', adm.id, 'admin', owner);
    h.core.access.setGrant(inst, 'user', act.id, 'interact', owner);
    const post = (u: { id: string }, version: number) => request(h.app).post('/api/instances/todo/activate').set('Host', h.host)
      .set('Authorization', `Bearer ${h.core.tokens.create(u.id, 't').token}`).send({ version });
    const denied = await post(act, 1);
    expect(denied.status).toBe(403);
    expect(h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(2);
    const allowed = await post(adm, 1);
    expect(allowed.status).toBe(200);
    expect(h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(1);
  });

  it('grants over REST', async () => {
    const { h, token } = setup();
    const ada = h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'pw-ada-12345', role: 'user' });
    const group = h.core.groups.create('team');
    h.core.apps.deploy({ slug: 'todo', html: '<p>1</p>', userId: h.adminId });
    const call = (method: 'get' | 'put' | 'delete', body?: object, bearer = token) => {
      const r = request(h.app)[method]('/api/instances/todo/grants').set('Host', h.host).set('Authorization', `Bearer ${bearer}`);
      return body ? r.send(body) : r;
    };
    expect((await call('get')).body).toEqual({ grants: [] });
    const put = await call('put', { email: 'ada@x.y', level: 'interact' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ grants: [{ type: 'user', label: 'ada@x.y', level: 'interact' }] });
    const inst = h.core.apps.getInstanceBySlug('todo')!;
    expect(h.core.access.levelFor(inst, ada)).toBe('interact');
    const byGroup = await call('put', { group: 'team', level: 'view' });
    expect(byGroup.body.grants).toEqual([
      { type: 'user', label: 'ada@x.y', level: 'interact' }, { type: 'group', label: 'team', level: 'view' },
    ]);
    expect(h.core.access.listGrants(inst.id).map((g) => g.principalId)).toContain(group.id);
    const changed = await call('put', { email: 'ada@x.y', level: 'admin' });
    expect(changed.body.grants[0]).toEqual({ type: 'user', label: 'ada@x.y', level: 'admin' });
    const del = await call('delete', { email: 'ada@x.y' });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ grants: [{ type: 'group', label: 'team', level: 'view' }] });
    expect((await call('delete', { group: 'team' })).body).toEqual({ grants: [] });
    expect(h.core.access.levelFor(inst, ada)).toBe('none');

    for (const body of [{ email: 'ada@x.y', group: 'team', level: 'view' }, { level: 'view' }]) {
      const bad = await call('put', body);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('invalid_argument');
    }
    expect((await call('delete', { email: 'ada@x.y', group: 'team' })).status).toBe(400);
    expect((await call('put', { email: 'ada@x.y', level: 'owner' })).status).toBe(400);
    expect((await call('put', { email: 'nobody@x.y', level: 'view' })).status).toBe(404);
    expect((await call('put', { group: 'nogroup', level: 'view' })).status).toBe(404);

    // not a manager: forbidden for every verb; an interact grantee is not a manager either
    h.core.access.setGrant(inst, 'user', ada.id, 'interact', h.core.users.get(h.adminId)!);
    const adaToken = h.core.tokens.create(ada.id, 't').token;
    for (const [m, b] of [['get', undefined], ['put', { email: 'ada@x.y', level: 'admin' }], ['delete', { email: 'ada@x.y' }]] as const) {
      expect((await call(m, b, adaToken)).status, m).toBe(403);
    }
    expect(h.core.access.levelFor(inst, ada)).toBe('interact');
    expect((await request(h.app).get('/api/instances/nope/grants').set('Host', h.host).set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });

  it('create instance over REST', async () => {
    const { h, token } = setup();
    const pub = h.core.users.create({ email: 'pub@x.y', name: 'Pub', password: 'pw-pub-12345', role: 'publisher' });
    const plain = h.core.users.create({ email: 'plain@x.y', name: 'Plain', password: 'pw-plain-1234', role: 'user' });
    const app = h.core.apps.deploy({ slug: 'todo', html: '<p>1</p>', userId: h.adminId }).app;
    const create = (body: object, bearer = token) => request(h.app).post('/api/apps/todo/instances').set('Host', h.host)
      .set('Authorization', `Bearer ${bearer}`).send(body);

    const mine = await create({ slug: 'todo-mine', visibility: 'users' });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ slug: 'todo-mine', url: 'http://todo-mine.apps.localhost:8080', activeVersion: 1, visibility: 'users' });
    expect(h.core.apps.getInstanceBySlug('todo-mine')!.ownerId).toBe(h.adminId);

    const forPub = await create({ slug: 'todo-pub', ownerEmail: 'pub@x.y' });
    expect(forPub.status).toBe(200);
    expect(h.core.apps.getInstanceBySlug('todo-pub')!.ownerId).toBe(pub.id);
    expect((await create({ slug: 'todo-ghost', ownerEmail: 'ghost@x.y' })).status).toBe(404);
    expect((await create({ slug: 'todo-mine' })).status).toBe(409);
    expect((await create({ slug: 'todo-bad', visibility: 'everyone' })).status).toBe(400);
    expect((await create({})).status).toBe(400);

    // a collaborator who deploys may create for others
    h.core.apps.addCollaborator(app.id, pub.id, h.adminId);
    const pubToken = h.core.tokens.create(pub.id, 't').token;
    expect((await create({ slug: 'todo-plain', ownerEmail: 'plain@x.y' }, pubToken)).status).toBe(200);
    expect(h.core.apps.getInstanceBySlug('todo-plain')!.ownerId).toBe(plain.id);

    // a plain user needs self-service
    const plainToken = h.core.tokens.create(plain.id, 't').token;
    const refused = await create({ slug: 'todo-nope' }, plainToken);
    expect(refused.status).toBe(403);
    expect(h.core.apps.getInstanceBySlug('todo-nope')).toBeNull();
    h.core.apps.setSelfInstances(app.id, 'users', h.adminId);
    const own = await create({ slug: 'todo-plain-own' }, plainToken);
    expect(own.status).toBe(200);
    expect(h.core.apps.getInstanceBySlug('todo-plain-own')!.ownerId).toBe(plain.id);
    // ...but cannot hand instances to others
    const other = await create({ slug: 'todo-plain-other', ownerEmail: 'pub@x.y' }, plainToken);
    expect(other.status).toBe(403);
    expect(h.core.apps.getInstanceBySlug('todo-plain-other')).toBeNull();
  });

  it('token management needs the session cookie', async () => {
    const { h, token } = setup();
    const viaBearer = await request(h.app).post('/api/tokens').set('Host', h.host).set('Authorization', `Bearer ${token}`).send({ name: 'x' });
    expect(viaBearer.status).toBe(403);
    expect((await request(h.app).get('/api/tokens').set('Host', h.host).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    // a bearer token next to a valid cookie still does not count
    const cookie = await h.login();
    const both = await request(h.app).post('/api/tokens').set('Host', h.host).set('Cookie', cookie).set('X-Lager-Request', '1')
      .set('Authorization', `Bearer ${token}`).send({ name: 'x' });
    expect(both.status).toBe(403);
    const noHeader = await request(h.app).post('/api/tokens').set('Host', h.host).set('Cookie', cookie).send({ name: 'x' });
    expect(noHeader.status).toBe(401);

    const created = await request(h.app).post('/api/tokens').set('Host', h.host).set('Cookie', cookie).set('X-Lager-Request', '1')
      .send({ name: 'ci' });
    expect(created.status).toBe(200);
    expect(created.body.token.startsWith('lgr_')).toBe(true);
    expect(created.body.info.name).toBe('ci');

    const list = await request(h.app).get('/api/tokens').set('Host', h.host).set('Cookie', cookie).set('X-Lager-Request', '1');
    expect(list.body.tokens.map((t: { name: string }) => t.name).sort()).toEqual(['ci', 'test']);
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);

    const del = await request(h.app).delete(`/api/tokens/${created.body.info.id}`).set('Host', h.host).set('Cookie', cookie)
      .set('X-Lager-Request', '1');
    expect(del.status).toBe(200);
    expect(h.core.tokens.verify(created.body.token)).toBeNull();
    const again = await request(h.app).delete(`/api/tokens/${created.body.info.id}`).set('Host', h.host).set('Cookie', cookie)
      .set('X-Lager-Request', '1');
    expect(again.status).toBe(404);
  });

  it('body over 16 MiB → 413 or 400', async () => {
    const { h, token } = setup();
    const big = 'a'.repeat(16 * 1024 * 1024 + 1);
    const res = await request(h.app).put('/api/apps/big').set('Host', h.host).set('Authorization', `Bearer ${token}`)
      .type('text/html').send(big);
    expect([413, 400]).toContain(res.status);
    expect(h.core.apps.getApp('big')).toBeNull();
  });
});
