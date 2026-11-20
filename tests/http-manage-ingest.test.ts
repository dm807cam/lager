import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { esc } from '../src/http/pages.js';
import { signToken } from '../src/http/tokens.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness, type HarnessOptions } from './support/http.js';

const en = (key: MessageKey, params?: Record<string, string | number>): string => esc(t('en', key, params));
let h: Harness;
afterEach(() => { h?.core.close(); });

const CAPS = { ingest: { endpoints: [{ name: 'hits', collection: 'pageviews', auth: 'none', origins: ['https://blog.example.com'] }, { name: 'weight', auth: 'token' }] } };

/** Publisher `p` owns `stats` (two endpoints); `m` manages its instance, `c` contributes to it, `u` has nothing to do with it. */
async function setup(opts: HarnessOptions = {}) {
  h = makeHarness({ ...opts, extensions: [dashboardExtension, manageExtension] });
  const mk = (email: string, role: 'publisher' | 'user'): User => h.core.users.create({ email, name: email.split('@')[0], password: 'password-123', role });
  const [p, m, c, u] = [mk('p@x.y', 'publisher'), mk('m@x.y', 'user'), mk('c@x.y', 'user'), mk('u@x.y', 'user')];
  const inst = h.core.apps.deploy({ slug: 'stats', html: '<p>1</p>', title: 'Stats', userId: p.id, capabilities: CAPS as never }).instances[0];
  h.core.access.setGrant(inst, 'user', m.id, 'admin', p);
  h.core.access.setGrant(inst, 'user', c.id, 'interact', p);
  const login = (user: User): Promise<string> => h.login(user.email, 'password-123');
  return { inst, p, m, c, u, pc: await login(p), mc: await login(m), cc: await login(c), uc: await login(u) };
}

const csrf = (user: User): string => signToken({ uid: user.id, k: 'ui', ep: h.core.users.get(user.id)?.sessionEpoch }, h.core.config.secret, 3600);
const page = (cookie: string) => request(h.app).get('/instances/stats').set('Host', h.host).set('Cookie', cookie);
const post = (cookie: string, user: User, path: string, body: Record<string, string> = {}) =>
  request(h.app).post(`/ui/instances/stats/ingest/${path}`).set('Host', h.host).set('Cookie', cookie).type('form').send({ csrf: csrf(user), ...body });

describe('instance page: data from outside', () => {
  it('shows every endpoint with its address, who may send, the token and the counters', async () => {
    const { inst, pc } = await setup();
    h.core.ingest.note(inst.id, 'hits', 'accepted');
    h.core.ingest.note(inst.id, 'hits', 'accepted');
    h.core.ingest.note(inst.id, 'hits', 'limited');
    const res = await page(pc);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(en('instance.ingest.title'));
    expect(res.text).toContain('http://stats.apps.localhost:8080/_ingest/hits');
    expect(res.text).toContain('http://stats.apps.localhost:8080/_ingest/weight');
    expect(res.text).toContain(`${en('instance.ingest.byOrigins')} <code>https://blog.example.com</code>`);
    expect(res.text).toContain(en('instance.ingest.into', { collection: 'pageviews' }));
    expect(res.text).toContain(en('instance.ingest.byToken'));
    const token = h.core.ingest.token(inst.id, 'weight');
    expect(res.text).toContain(`<code>${token}</code>`);
    // Only the endpoint that needs a token shows one.
    expect(res.text.match(/lgi_/g)).toHaveLength(2);
    expect(res.text).toMatch(/2 accepted, 0 refused, 1 over the limit since /);
    expect(res.text).toContain('0 B of 10.0 MiB');
  });

  it('is missing for an app without endpoints and says so when the server has receiving switched off', async () => {
    const { p, pc } = await setup({ ingestQuotaBytes: 0 });
    const off = await page(pc);
    expect(off.text).toContain(en('instance.ingest.serverOff'));
    expect(off.text).not.toContain('lgi_');
    h.core.apps.deploy({ slug: 'stats', html: '<p>2</p>', userId: p.id });
    expect((await page(pc)).text).not.toContain(en('instance.ingest.title'));
  });

  it('the switch closes an endpoint at once and opens it again', async () => {
    const { inst, p, pc } = await setup();
    const send = () => request(h.app).post('/_ingest/hits').set('Host', 'stats.apps.localhost').set('Origin', 'https://blog.example.com').send({ a: 1 });
    expect((await send()).status).toBe(202);
    const off = await post(pc, p, 'switch', { name: 'hits', on: '0' });
    expect(off.status).toBe(302);
    expect(off.headers.location).toBe('/instances/stats');
    expect(h.core.ingest.isOff(inst.id, 'hits')).toBe(true);
    expect((await send()).status).toBe(404);
    const shown = await page(pc);
    expect(shown.text).toContain(en('instance.ingest.turnOn'));
    expect(shown.text).toContain(`<span class="badge-text">${en('instance.ingest.off')}</span>`);
    await post(pc, p, 'switch', { name: 'hits', on: '1' });
    expect((await send()).status).toBe(202);
    // The other endpoint was never touched.
    expect(h.core.ingest.isOff(inst.id, 'weight')).toBe(false);
  });

  it('replacing the token ends the old one and shows the new one', async () => {
    const { inst, m, mc } = await setup();
    const before = h.core.ingest.token(inst.id, 'weight');
    expect((await post(mc, m, 'token', { name: 'weight' })).status).toBe(302);
    const after = h.core.ingest.token(inst.id, 'weight');
    expect(after).not.toBe(before);
    const shown = (await page(mc)).text;
    expect(shown).toContain(after);
    expect(shown).not.toContain(before);
    const send = (token: string) => request(h.app).post('/_ingest/weight').set('Host', 'stats.apps.localhost').set('Authorization', `Bearer ${token}`).send({ kg: 70 });
    expect((await send(before)).status).toBe(401);
    expect((await send(after)).status).toBe(202);
  });

  it('only people who manage the instance see the page and use its forms', async () => {
    const { inst, c, u, cc, uc } = await setup();
    const token = h.core.ingest.token(inst.id, 'weight');
    for (const [cookie, user] of [[cc, c], [uc, u]] as const) {
      const shown = await page(cookie);
      expect(shown.status).toBe(403);
      expect(shown.text).not.toContain('lgi_');
      expect((await post(cookie, user, 'switch', { name: 'hits', on: '0' })).status).toBe(403);
      expect((await post(cookie, user, 'token', { name: 'weight' })).status).toBe(403);
    }
    expect(h.core.ingest.isOff(inst.id, 'hits')).toBe(false);
    expect(h.core.ingest.token(inst.id, 'weight')).toBe(token);
  });

  it('a form without the right token, or for an endpoint the app does not have, changes nothing', async () => {
    const { inst, p, m, pc } = await setup();
    const token = h.core.ingest.token(inst.id, 'weight');
    const noCsrf = await request(h.app).post('/ui/instances/stats/ingest/token').set('Host', h.host).set('Cookie', pc).type('form').send({ name: 'weight' });
    expect(noCsrf.status).toBe(403);
    // The form token of another account is not this account's.
    const foreign = await request(h.app).post('/ui/instances/stats/ingest/token').set('Host', h.host).set('Cookie', pc).type('form').send({ csrf: csrf(m), name: 'weight' });
    expect(foreign.status).toBe(403);
    expect(h.core.ingest.token(inst.id, 'weight')).toBe(token);
    expect((await post(pc, p, 'switch', { name: 'nothing', on: '0' })).status).toBe(404);
    expect((await post(pc, p, 'token', { name: '' })).status).toBe(404);
    expect(h.core.ingest.isOff(inst.id, 'nothing')).toBe(false);
  });

  it('deleting the instance removes what was decided about its endpoints', async () => {
    const { inst, p } = await setup();
    h.core.ingest.setOff(inst.id, 'hits', true);
    h.core.ingest.rotateToken(inst.id, 'weight');
    h.core.ingest.note(inst.id, 'hits', 'refused');
    h.core.apps.deleteInstance(inst.id, p.id);
    expect(h.core.ingest.isOff(inst.id, 'hits')).toBe(false);
    expect(h.core.ingest.countsOf(inst.id, 'hits')).toEqual({ accepted: 0, refused: 0, limited: 0 });
  });
});
