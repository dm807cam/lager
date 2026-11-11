import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { purgeTrash, startTrashPurge } from '../src/data/trash.js';
import { loadConfig } from '../src/config.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { signToken } from '../src/http/tokens.js';
import { LagerError } from '../src/errors.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness;
afterEach(() => {
  vi.useRealTimers();
  if (h) { h.core.close(); h = undefined as unknown as Harness; }
});

const html = '<p>x</p>';
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof LagerError) return e.code; throw e; }
  return 'none';
};
function world() {
  h = makeHarness({ extensions: [dashboardExtension, manageExtension] });
  const mk = (email: string, role: 'admin' | 'publisher' | 'user') => h.core.users.create({ email, name: email.split('@')[0], password: 'password-123', role });
  return { admin: h.core.users.get(h.adminId)!, p: mk('p@x.y', 'publisher'), q: mk('q@x.y', 'publisher'), u: mk('u@x.y', 'user') };
}
const csrf = (user: User): string => signToken({ uid: user.id, k: 'ui' }, h.core.config.secret, 3600);
const post = (cookie: string, user: User, path: string, body: Record<string, string> = {}) =>
  request(h.app).post(path).set('Host', h.host).set('Cookie', cookie).type('form').send({ csrf: csrf(user), ...body });

describe('retired slugs', () => {
  it('another user cannot reuse a deleted slug (createInstance, first deploy), the former owner can', () => {
    const { p, q } = world();
    const { app, instances } = h.core.apps.deploy({ slug: 'notes', html, userId: p.id });
    const extra = h.core.apps.createInstance({ appId: app.id, slug: 'notes-2', ownerId: p.id });
    h.core.apps.deleteInstance(extra.id, p.id);
    h.core.apps.deleteInstance(instances[0].id, p.id);

    const other = h.core.apps.deploy({ slug: 'other', html, userId: q.id }).app;
    expect(code(() => h.core.apps.createInstance({ appId: other.id, slug: 'notes-2', ownerId: q.id }))).toBe('conflict');
    expect(() => h.core.apps.createInstance({ appId: other.id, slug: 'notes-2', ownerId: q.id })).toThrow(expect.objectContaining({ reason: 'slug_retired' }));
    expect(code(() => h.core.apps.createInstance({ appId: other.id, slug: 'notes', ownerId: q.id }))).toBe('conflict');
    expect(h.core.apps.getInstanceBySlug('notes-2')).toBeNull();

    // The former owner gets it back, and the reservation is lifted.
    const back = h.core.apps.createInstance({ appId: app.id, slug: 'notes-2', ownerId: p.id });
    expect(back.slug).toBe('notes-2');
    h.core.apps.deleteInstance(back.id, p.id);
    expect(code(() => h.core.apps.createInstance({ appId: other.id, slug: 'notes-2', ownerId: q.id }))).toBe('conflict');
  });

  it('a refused first deploy leaves nothing behind and keeps the reservation', () => {
    const { p, q } = world();
    const { instances } = h.core.apps.deploy({ slug: 'solo', html, userId: p.id });
    h.core.apps.deleteInstance(instances[0].id, p.id);
    h.core.apps.deleteApp(h.core.apps.getApp('solo')!.id, p.id);
    expect(code(() => h.core.apps.deploy({ slug: 'solo', html, userId: q.id }))).toBe('conflict');
    expect(h.core.apps.getApp('solo')).toBeNull();
  });

  it('app deletion retires the slugs of its instances', () => {
    const { p, q } = world();
    const { app } = h.core.apps.deploy({ slug: 'gone', html, userId: p.id });
    h.core.apps.createInstance({ appId: app.id, slug: 'gone-b', ownerId: p.id });
    h.core.apps.deleteApp(app.id, p.id);
    const other = h.core.apps.deploy({ slug: 'other', html, userId: q.id }).app;
    for (const slug of ['gone', 'gone-b']) {
      expect(code(() => h.core.apps.createInstance({ appId: other.id, slug, ownerId: q.id })), slug).toBe('conflict');
    }
    expect(h.core.apps.deploy({ slug: 'gone', html, userId: p.id }).createdApp).toBe(true);
  });

  it('the self-service route refuses a retired slug with a German notice, the former owner may reuse it', async () => {
    const { p, q, u } = world();
    const { app, instances } = h.core.apps.deploy({ slug: 'notes', html, userId: p.id });
    h.core.apps.setSelfInstances(app.id, 'users', p.id);
    const qc = await h.login(q.email, 'password-123');
    const uc = await h.login(u.email, 'password-123');
    const mine = await post(uc, u, '/ui/apps/notes/instances', { slug: 'mine' });
    expect(mine.status).toBe(302);
    const inst = h.core.apps.getInstanceBySlug('mine')!;
    h.core.apps.deleteInstance(inst.id, u.id);
    h.core.apps.deleteInstance(instances[0].id, p.id);
    h.core.apps.createInstance({ appId: app.id, slug: 'keep', ownerId: p.id });

    const refused = await post(qc, q, '/ui/apps/notes/instances', { slug: 'mine' });
    expect(refused.status).toBe(302);
    // q is a publisher but no collaborator, so the self-service path applies.
    const page = await request(h.app).get(refused.headers.location as string).set('Host', h.host).set('Cookie', qc);
    expect(page.text).toContain('Dieser Name wurde bereits verwendet und ist gesperrt.');
    expect(h.core.apps.getInstanceBySlug('mine')).toBeNull();

    const again = await post(uc, u, '/ui/apps/notes/instances', { slug: 'mine' });
    expect(again.status).toBe(302);
    expect(h.core.apps.getInstanceBySlug('mine')?.ownerId).toBe(u.id);
  });
});

describe('instance creation limit', () => {
  it('refuses the 11th creation within 24 hours, also after deleting, and allows it after the window', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T10:00:00Z'), toFake: ['Date'] });
    const { p } = world();
    const { app, instances } = h.core.apps.deploy({ slug: 'base', html, userId: p.id }); // creation 1 (implicit instance)
    for (let i = 2; i <= 10; i++) {
      const inst = h.core.apps.createInstance({ appId: app.id, slug: `i-${i}`, ownerId: p.id });
      h.core.apps.deleteInstance(inst.id, p.id); // deleting does not give the budget back
    }
    expect(h.core.apps.listInstancesOwnedBy(p.id)).toHaveLength(1);
    expect(() => h.core.apps.createInstance({ appId: app.id, slug: 'i-11', ownerId: p.id })).toThrow(expect.objectContaining({ reason: 'creation_rate' }));
    expect(code(() => h.core.apps.createInstance({ appId: app.id, slug: 'i-11', ownerId: p.id }))).toBe('conflict');
    expect(code(() => h.core.apps.deploy({ slug: 'second', html, userId: p.id }))).toBe('conflict');
    expect(h.core.apps.getApp('second')).toBeNull();

    vi.setSystemTime(new Date('2026-01-02T10:00:01Z'));
    expect(h.core.apps.createInstance({ appId: app.id, slug: 'i-11', ownerId: p.id }).slug).toBe('i-11');
    expect(instances).toHaveLength(1);
  });

  it('administrators are exempt', () => {
    const { admin } = world();
    const { app } = h.core.apps.deploy({ slug: 'adm', html, userId: admin.id });
    for (let i = 0; i < 15; i++) h.core.apps.createInstance({ appId: app.id, slug: `a-${i}`, ownerId: admin.id });
    expect(h.core.apps.listInstancesOwnedBy(admin.id)).toHaveLength(16);
  });
});

describe('disabled instances', () => {
  it('the owner can still open the page and delete an instance an administrator disabled', async () => {
    const { p, u } = world();
    h.core.apps.deploy({ slug: 'notes', html, userId: p.id });
    const pc = await h.login(p.email, 'password-123');
    const uc = await h.login(u.email, 'password-123');
    h.core.apps.setInstanceDisabled(h.core.apps.getInstanceBySlug('notes')!.id, true);
    const page = await request(h.app).get('/instances/notes').set('Host', h.host).set('Cookie', pc);
    expect(page.status).toBe(200);
    expect(page.text).toContain('deaktiviert');
    expect(page.text).toContain('action="/ui/instances/notes/delete"');
    expect(page.text).not.toContain('/visibility');
    expect((await request(h.app).get('/instances/notes').set('Host', h.host).set('Cookie', uc)).status).toBe(403);
    expect((await post(uc, u, '/ui/instances/notes/delete', { confirm: 'notes' })).status).toBe(403);
    expect(h.core.apps.getInstanceBySlug('notes')).not.toBeNull();
    const dash = await request(h.app).get('/').set('Host', h.host).set('Cookie', pc);
    expect(dash.text).toContain('href="/instances/notes"');

    const instanceId = h.core.apps.getInstanceBySlug('notes')!.id;
    fs.mkdirSync(path.join(h.core.config.dataDir, 'instances', instanceId), { recursive: true });
    const del = await post(pc, p, '/ui/instances/notes/delete', { confirm: 'notes' });
    expect(del.status).toBe(302);
    expect(h.core.apps.getInstanceBySlug('notes')).toBeNull();
    // The slug is retired for the owner.
    const other = h.core.apps.deploy({ slug: 'other', html, userId: p.id }).app;
    expect(h.core.apps.createInstance({ appId: other.id, slug: 'notes', ownerId: p.id }).slug).toBe('notes');
  });
});

describe('trash retention', () => {
  const day = 24 * 3600_000;
  const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:.]/g, '');
  const mkTrash = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-trash-'));
    fs.mkdirSync(path.join(dir, 'trash'));
    return dir;
  };
  const entry = (dir: string, name: string): void => {
    fs.mkdirSync(path.join(dir, 'trash', name));
    fs.writeFileSync(path.join(dir, 'trash', name, 'data.sqlite'), 'x');
  };
  const names = (dir: string): string[] => fs.readdirSync(path.join(dir, 'trash')).sort();

  it('removes only entries older than the retention', () => {
    const dir = mkTrash();
    const now = Date.parse('2026-06-01T00:00:00Z');
    entry(dir, `inst-old-${stamp(now - 31 * day)}`);
    entry(dir, `app-old-${stamp(now - 40 * day)}`);
    entry(dir, `inst-new-${stamp(now - 29 * day)}`);
    entry(dir, `inst-fresh-${stamp(now - 1000)}`);
    expect(purgeTrash(dir, 30, now)).toBe(2);
    expect(names(dir)).toEqual([`inst-fresh-${stamp(now - 1000)}`, `inst-new-${stamp(now - 29 * day)}`]);
  });

  it('falls back to the directory mtime when the name carries no stamp', () => {
    const dir = mkTrash();
    entry(dir, 'odd');
    entry(dir, 'odd-new');
    const old = new Date(Date.now() - 60 * day);
    fs.utimesSync(path.join(dir, 'trash', 'odd'), old, old);
    expect(purgeTrash(dir, 30)).toBe(1);
    expect(names(dir)).toEqual(['odd-new']);
  });

  it('keeps everything with retention 0 and survives a missing trash directory', () => {
    const dir = mkTrash();
    entry(dir, `inst-ancient-${stamp(Date.parse('2001-01-01T00:00:00Z'))}`);
    expect(purgeTrash(dir, 0)).toBe(0);
    expect(names(dir)).toHaveLength(1);
    expect(purgeTrash(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-notrash-')), 30)).toBe(0);
    const lines: string[] = [];
    startTrashPurge(dir, 0, (l) => lines.push(l))();
    expect(lines).toEqual([]);
  });

  it('runs at start and then every 24 hours, one log line per run', () => {
    vi.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
    const dir = mkTrash();
    entry(dir, `inst-a-${stamp(Date.now() - 31 * day)}`);
    const lines: string[] = [];
    const stop = startTrashPurge(dir, 30, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('removed 1 ');
    entry(dir, `inst-b-${stamp(Date.now() - 31 * day)}`);
    vi.advanceTimersByTime(day + 1000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('removed 1 ');
    expect(names(dir)).toEqual([]);
    stop();
    vi.advanceTimersByTime(3 * day);
    expect(lines).toHaveLength(2);
  });

  it('LAGER_TRASH_DAYS defaults to 30 and accepts 0', () => {
    const env = { LAGER_PUBLIC_URL: 'http://localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lager-cfg-')) };
    expect(loadConfig(env).trashDays).toBe(30);
    expect(loadConfig({ ...env, LAGER_TRASH_DAYS: '0' }).trashDays).toBe(0);
    expect(loadConfig({ ...env, LAGER_TRASH_DAYS: '7' }).trashDays).toBe(7);
    expect(() => loadConfig({ ...env, LAGER_TRASH_DAYS: '-1' })).toThrow();
  });
});
