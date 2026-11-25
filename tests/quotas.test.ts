import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { manageExtension } from '../src/http/manage.js';
import { esc } from '../src/http/pages.js';
import { csrfToken } from '../src/http/session.js';
import { t } from '../src/i18n/index.js';
import { MAX_QUOTA_MB } from '../src/platform/quotas.js';
import { makeHarness, type Harness } from './support/http.js';

const MIB = 1024 * 1024;
const PASSWORD = 'correct horse battery';
let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

function setup() {
  h = makeHarness({ extensions: [adminExtension, manageExtension], instanceQuotaBytes: 4 * MIB });
  const hh = h;
  const pub = hh.core.users.create({ email: 'pub@x.y', name: 'Pia', password: PASSWORD, role: 'publisher' });
  const other = hh.core.users.create({ email: 'ola@x.y', name: 'Ola', password: PASSWORD, role: 'publisher' });
  const notes = hh.core.apps.deploy({ slug: 'notes', html: '<h1>notes</h1>', userId: pub.id });
  const board = hh.core.apps.deploy({ slug: 'board', html: '<h1>board</h1>', userId: other.id });
  const post = (path: string, cookie: string, body: Record<string, string>) =>
    request(hh.app).post(path).set('Host', hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(hh.core, hh.core.users.get(hh.adminId)!), ...body });
  const get = (path: string, cookie: string) => request(hh.app).get(path).set('Host', hh.host).set('Cookie', cookie);
  return { hh, pub, other, notes: notes.app, notesInstance: notes.instances[0], board: board.app, boardInstance: board.instances[0], post, get };
}

describe('storage per group and per app', () => {
  it('follows the default, then the largest group of the owner, then the app', () => {
    const s = setup();
    const { quotas, groups } = s.hh.core;
    const inst = s.notesInstance.id;
    expect(quotas.resolve(inst)).toEqual({ bytes: 4 * MIB, source: 'default' });
    const small = groups.create('Small');
    const large = groups.create('Large');
    quotas.setGroup(small.id, 2 * MIB);
    quotas.setGroup(large.id, 100 * MIB);
    // A group applies only to the instances its members own.
    groups.addMember(small.id, s.pub.id);
    expect(quotas.resolve(inst)).toEqual({ bytes: 2 * MIB, source: 'group' });
    expect(quotas.of(s.boardInstance.id)).toBe(4 * MIB);
    // One more group never takes space away: the largest setting wins, also when it is smaller than the default.
    groups.addMember(large.id, s.pub.id);
    expect(quotas.of(inst)).toBe(100 * MIB);
    // The app's own setting comes first, even when it is smaller.
    quotas.setApp(s.notes.id, 3 * MIB);
    expect(quotas.resolve(inst)).toEqual({ bytes: 3 * MIB, source: 'app' });
    quotas.setApp(s.notes.id, null);
    expect(quotas.of(inst)).toBe(100 * MIB);
    groups.removeMember(large.id, s.pub.id);
    expect(quotas.of(inst)).toBe(2 * MIB);
    groups.delete(small.id);
    expect(quotas.resolve(inst)).toEqual({ bytes: 4 * MIB, source: 'default' });
  });

  it('refuses sizes outside 1 MiB to the limit, and unknown apps and groups', () => {
    const s = setup();
    const { quotas } = s.hh.core;
    const group = s.hh.core.groups.create('Team');
    for (const bad of [0, MIB - 1, 1.5, NaN, (MAX_QUOTA_MB + 1) * MIB]) {
      expect(() => quotas.setGroup(group.id, bad)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
      expect(() => quotas.setApp(s.notes.id, bad)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    expect(quotas.ofGroup(group.id)).toBeNull();
    expect(() => quotas.setGroup('nope', MIB)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => quotas.setApp('nope', MIB)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('is what uploads, documents and saved pages are held to', () => {
    const s = setup();
    const { quotas, assets, data, apps } = s.hh.core;
    const file = Buffer.alloc(2 * MIB, 'a');
    quotas.setApp(s.notes.id, MIB);
    expect(() => assets.put(s.notesInstance.id, file, 'text/plain', null)).toThrow(expect.objectContaining({ code: 'quota_exceeded' }));
    expect(assets.maxBytes(s.notesInstance.id)).toBeLessThanOrEqual(MIB);
    // The other app keeps the default of 4 MiB.
    expect(assets.put(s.boardInstance.id, file, 'text/plain', null).sizeBytes).toBe(2 * MIB);
    // A group of the owner gives the board instance more room, until its app is held to less.
    const group = s.hh.core.groups.create('Team');
    quotas.setGroup(group.id, 8 * MIB);
    s.hh.core.groups.addMember(group.id, s.other.id);
    expect(assets.put(s.boardInstance.id, Buffer.alloc(3 * MIB, 'b'), 'text/plain', null).sizeBytes).toBe(3 * MIB);
    quotas.setApp(s.board.id, 2 * MIB);
    expect(() => data.set(s.boardInstance.id, 'notes/a', { text: 'x' }, null)).toThrow(expect.objectContaining({ code: 'quota_exceeded' }));
    expect(() => apps.selfPublish({ instanceId: s.boardInstance.id, html: '<h1>saved</h1>', baseVersion: s.boardInstance.activeVersion, userId: s.other.id }))
      .toThrow(expect.objectContaining({ code: 'quota_exceeded' }));
    quotas.setApp(s.board.id, null);
    expect(data.set(s.boardInstance.id, 'notes/a', { text: 'x' }, null).path).toBe('notes/a');
  });

  it('an administrator sets it on the group page and in the apps overview', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const group = s.hh.core.groups.create('Team');
    const page = await s.get(`/admin/groups/${group.id}`, admin);
    expect(page.text).toContain(esc(t('en', 'admin.quota.title')));
    expect(page.text).toContain('placeholder="4"');
    expect((await s.post(`/admin/groups/${group.id}/quota`, admin, { quota: ' 12 ' })).headers.location).toBe(`/admin/groups/${group.id}`);
    expect(s.hh.core.quotas.ofGroup(group.id)).toBe(12 * MIB);
    expect((await s.get(`/admin/groups/${group.id}`, admin)).text).toContain('value="12"');
    const bad = await s.post(`/admin/groups/${group.id}/quota`, admin, { quota: '1.5' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain(esc(t('en', 'admin.quota.invalid', { max: MAX_QUOTA_MB })));
    expect(s.hh.core.quotas.ofGroup(group.id)).toBe(12 * MIB);
    await s.post(`/admin/groups/${group.id}/quota`, admin, { quota: '' });
    expect(s.hh.core.quotas.ofGroup(group.id)).toBeNull();
    expect((await s.post('/admin/groups/nope/quota', admin, { quota: '5' })).status).toBe(404);

    expect((await s.get('/admin/apps', admin)).text).toContain(`/admin/apps/${s.notes.id}/quota`);
    expect((await s.post(`/admin/apps/${s.notes.id}/quota`, admin, { quota: '7' })).headers.location).toBe('/admin/apps');
    expect(s.hh.core.quotas.ofApp(s.notes.id)).toBe(7 * MIB);
    expect(s.hh.core.quotas.of(s.notesInstance.id)).toBe(7 * MIB);
    expect((await s.get('/admin/apps', admin)).text).toContain('7.0 MiB');
    expect((await s.post(`/admin/apps/${s.notes.id}/quota`, admin, { quota: '0' })).status).toBe(400);
    expect((await s.post('/admin/apps/nope/quota', admin, { quota: '5' })).status).toBe(404);
    await s.post(`/admin/apps/${s.notes.id}/quota`, admin, { quota: '' });
    expect(s.hh.core.quotas.ofApp(s.notes.id)).toBeNull();
  });

  it('only administrators can change it', async () => {
    const s = setup();
    const cookie = await s.hh.login('pub@x.y', PASSWORD);
    const res = await request(s.hh.app).post(`/admin/apps/${s.notes.id}/quota`).set('Host', s.hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.hh.core, s.pub), quota: '500' });
    expect(res.status).toBe(403);
    expect(s.hh.core.quotas.ofApp(s.notes.id)).toBeNull();
  });

  it('the instance page shows the storage that applies to it', async () => {
    const s = setup();
    s.hh.core.quotas.setApp(s.notes.id, 9 * MIB);
    const cookie = await s.hh.login('pub@x.y', PASSWORD);
    const page = await s.get(`/instances/${s.notesInstance.slug}`, cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('9.0 MiB');
  });
});
