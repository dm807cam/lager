import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { adminExtension } from '../src/http/admin.js';
import { apiExtension } from '../src/http/api.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { esc } from '../src/http/pages.js';
import { csrfToken } from '../src/http/session.js';
import { LOCALES, t, type MessageKey } from '../src/i18n/index.js';
import { mcpExtension } from '../src/mcp/http.js';
import type { Core } from '../src/core.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness } from './support/http.js';

const PASSWORD = 'correct horse battery';
const en = (key: MessageKey, params?: Record<string, string | number>): string => esc(t('en', key, params));
let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const dbOf = (core: Core): DatabaseSync => (core.apps as unknown as { db: DatabaseSync }).db;

/** Every place in the platform database where `id` still stands, as `table.column`. */
function references(core: Core, id: string): string[] {
  const db = dbOf(core);
  const found: string[] = [];
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const table of tables) {
    for (const column of (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name)) {
      const hits = (db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE CAST("${column}" AS TEXT) LIKE ?`).get(`%${id}%`) as { c: number }).c;
      if (hits > 0) found.push(`${table}.${column}`);
    }
  }
  return found.sort();
}

interface World { core: Core; admin: User; boss: User; pia: User; uwe: User; cookie: string; post: (path: string, body: Record<string, string>, as?: { user: User; cookie: string }) => request.Test; get: (path: string, cookie?: string) => request.Test }

/**
 * Pia, a publisher, with something in every table that can name an account: an app with two instances (one shared, one with a
 * custom domain and a page it saved itself), an instance of the administrator's app, a version she deployed to that app as a
 * collaborator, a share and a group membership, an API token, an OAuth grant, an invitation she issued while she was an
 * administrator, a pending reset link, an AI group, a name she retired, and documents she wrote in someone else's instance.
 */
async function world(): Promise<World> {
  h = makeHarness({ extensions: [adminExtension, dashboardExtension, apiExtension, mcpExtension] });
  const { core } = h;
  const admin = core.users.get(h.adminId)!;
  const boss = core.users.create({ email: 'boss@x.y', name: 'Boss', password: PASSWORD, role: 'admin' });
  const pia = core.users.create({ email: 'pia@x.y', name: 'Pia', password: PASSWORD, role: 'admin' });
  const uwe = core.users.create({ email: 'uwe@x.y', name: 'Uwe', password: PASSWORD, role: 'user' });
  // An invitation that was used stays on record when its issuer loses the administrator role; open ones are withdrawn then.
  const invite = await core.accounts.createInvite({ role: 'user', createdBy: pia.id });
  await core.accounts.register({ name: 'Guest', email: 'guest@x.y', password: PASSWORD, inviteToken: new URL(invite.url).searchParams.get('invite')! });
  core.users.setRole(pia.id, 'publisher');
  await core.accounts.createInvite({ role: 'user', email: 'later@x.y', createdBy: admin.id });

  const board = core.apps.deploy({ slug: 'board', html: '<p>board 1</p>', title: 'Board', userId: pia.id, capabilities: { db: {}, assets: {} } });
  core.data.set(board.instances[0].id, 'cards/a', { text: 'kept' }, pia.id);
  core.assets.put(board.instances[0].id, Buffer.from('file'), 'text/plain', pia.id);
  core.settings.setCustomDomains('publishers');
  core.domains.add(board.instances[0], 'board.example.org', pia, true);
  core.access.setGrant(board.instances[0], 'user', uwe.id, 'view', pia);
  core.access.setGrant(board.instances[0], 'user', admin.id, 'interact', pia);
  const second = core.apps.createInstance({ appId: board.app.id, slug: 'board-two', ownerId: pia.id });
  core.apps.selfPublish({ instanceId: second.id, html: '<p>saved</p>', baseVersion: 1, userId: pia.id });
  core.apps.addCollaborator(board.app.id, admin.id, pia.id);
  core.apps.deleteInstance(core.apps.createInstance({ appId: board.app.id, slug: 'board-old', ownerId: pia.id }).id, pia.id);

  const notes = core.apps.deploy({ slug: 'notes', html: '<p>notes 1</p>', title: 'Notes', userId: admin.id, capabilities: { db: {} } });
  core.apps.addCollaborator(notes.app.id, pia.id, admin.id);
  core.apps.deploy({ slug: 'notes', html: '<p>notes 2</p>', userId: pia.id, capabilities: { db: {} } });
  const piasNotes = core.apps.createInstance({ appId: notes.app.id, slug: 'notes-pia', ownerId: pia.id, createdBy: pia.id });
  core.data.set(piasNotes.id, 'notes/a', { text: 'mine' }, pia.id);
  core.apps.createInstance({ appId: notes.app.id, slug: 'notes-uwe', ownerId: uwe.id, createdBy: pia.id });
  core.access.setGrant(notes.instances[0], 'user', pia.id, 'admin', admin);
  core.access.setGrant(notes.instances[0], 'user', uwe.id, 'view', pia);
  core.data.set(notes.instances[0].id, 'notes/by-pia', { text: 'stays' }, pia.id);

  const group = core.groups.create('Team');
  core.groups.addMember(group.id, pia.id);
  core.tokens.create(pia.id, 'laptop');
  core.accounts.createResetLink(pia.id);
  const provider = core.ai.createProvider({ name: 'Local', type: 'ollama', baseUrl: 'http://localhost:11434/v1' });
  const model = core.ai.createModel({ id: 'fast', providerId: provider.id, model: 'llama3', description: '' });
  core.ai.assign(pia.id, core.ai.createGroup({ name: 'Writers', modelId: model.id, allowed: [], hourlyLimit: 10 }).id);

  const cookie = await h.login();
  const piaCookie = await h.login('pia@x.y', PASSWORD);
  // Deactivating ends the sessions and the OAuth grants; rows of a grant that is still in the tables are put there afterwards.
  core.users.setDisabled(pia.id, true);
  const client = core.oauth.registerClient({ client_id: 'c1', redirect_uris: ['https://client.example/cb'] } as never);
  core.oauth.issueTokens(client.client_id, pia.id, 'grant-1', 'mcp', null);
  core.oauth.issueCode({ clientId: client.client_id, userId: pia.id, redirectUri: 'https://client.example/cb', codeChallenge: 'x', scopes: ['mcp'] });
  expect(piaCookie).toContain('lager_session=');

  const hh = h;
  const get: World['get'] = (p, c = cookie) => request(hh.app).get(p).set('Host', hh.host).set('Cookie', c);
  const post: World['post'] = (p, body, as = { user: admin, cookie }) =>
    request(hh.app).post(p).set('Host', hh.host).set('Cookie', as.cookie).type('form').send({ csrf: csrfToken(core, as.user), ...body });
  return { core, admin, boss, pia, uwe, cookie, post, get };
}

const trashNames = (core: Core): string[] => {
  const dir = path.join(core.config.dataDir, 'trash');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

describe('deleting an account', () => {
  it('the world really names the account in every table that can', async () => {
    const w = await world();
    expect(references(w.core, w.pia.id)).toEqual([
      'account_tokens.created_by', 'account_tokens.user_id', 'api_tokens.user_id', 'app_collaborators.user_id', 'apps.owner_id',
      'grants.created_by', 'grants.principal_id', 'group_members.user_id', 'instance_creations.user_id', 'instance_domains.created_by',
      'instances.owner_id', 'oauth_codes.user_id', 'oauth_tokens.user_id', 'retired_slugs.owner_id', 'users.id', 'versions.created_by',
    ]);
    expect(dbOf(w.core).prepare('SELECT ai_group_id FROM users WHERE id = ?').get(w.pia.id)).not.toEqual({ ai_group_id: null });
  });

  it('the users page offers "Delete account" for a deactivated account only, and never for oneself', async () => {
    const w = await world();
    const doc = new JSDOM((await w.get('/admin/users')).text).window.document;
    const links = [...doc.querySelectorAll('a[href$="/delete"]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/admin/users/${w.pia.id}/delete`]);
    expect(links[0].getAttribute('aria-label')).toBe(t('en', 'admin.users.delete.of', { email: 'pia@x.y' }));
    expect(links[0].textContent).toBe(t('en', 'admin.users.delete'));
  });

  it('the confirmation page lists what the account owns with counts and asks what to do with it', async () => {
    const w = await world();
    const res = await w.get(`/admin/users/${w.pia.id}/delete`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const doc = new JSDOM(res.text).window.document;
    const owned = [...doc.querySelectorAll('dl.facts > div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(owned).toEqual([['Apps 1', 'board'], ['Instances 3', 'board, board-two, notes-pia']]);
    const form = doc.querySelector(`form[action="/admin/users/${w.pia.id}/delete"]`)!;
    const radios = [...form.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input[type="radio"][name="owned"]')];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([['transfer', true], ['delete', false]]);
    expect(form.querySelector('[role="radiogroup"]')!.getAttribute('aria-labelledby')).toBe('owned-what');
    expect(doc.getElementById('owned-what')!.textContent).toBe(t('en', 'admin.users.delete.what'));
    // The acting administrator is the default heir; every control has a label and is reachable without script.
    expect(form.querySelector<HTMLInputElement>('input[name="transfer_to"]')!.value).toBe('admin@x.y');
    expect(form.querySelector('input[name="confirm"]')!.getAttribute('data-confirm')).toBe('pia@x.y');
    for (const input of form.querySelectorAll('input:not([type="hidden"])')) {
      expect(input.closest('label') ?? doc.querySelector(`label[for="${input.id}"]`), input.getAttribute('name')!).not.toBeNull();
    }
    expect(form.querySelector('button[type="submit"]')!.textContent).toBe(t('en', 'admin.users.delete.submit'));
    expect(res.text).toContain(en('admin.users.delete.text', { name: 'Pia', email: 'pia@x.y' }));

    // An account that owns nothing is not asked the question.
    w.core.users.setDisabled(w.uwe.id, true);
    w.core.apps.deleteInstance(w.core.apps.getInstanceBySlug('notes-uwe')!.id, w.uwe.id);
    const empty = await w.get(`/admin/users/${w.uwe.id}/delete`);
    expect(empty.text).toContain(en('admin.users.delete.ownsNothing'));
    expect(empty.text).not.toContain('name="owned"');
  });

  it('the page renders in every language', async () => {
    const w = await world();
    for (const locale of LOCALES) {
      const res = await w.get(`/admin/users/${w.pia.id}/delete`, `${w.cookie}; lager_lang=${locale}`);
      const body = res.text.replace(/<script id="theme-init"[^>]*>[\s\S]*?<\/script>/, '');
      expect(body, locale).not.toContain('{');
      for (const key of ['admin.users.delete.what', 'admin.users.delete.transfer', 'admin.users.delete.trash', 'admin.users.delete.submit'] as const) {
        expect(body, `${locale} ${key}`).toContain(esc(t(locale, key)));
      }
    }
  });

  it('transfer: everything goes to the chosen account, and no row names the deleted one', async () => {
    const w = await world();
    const before = trashNames(w.core);
    const res = await w.post(`/admin/users/${w.pia.id}/delete`, { owned: 'transfer', transfer_to: 'Admin@X.y', confirm: 'pia@x.y' });
    expect(res.status).toBe(200);
    expect(res.text).toContain(en('admin.users.delete.done', { email: 'pia@x.y' }));
    expect(res.text).not.toContain(`/admin/users/${w.pia.id}/`);

    expect(w.core.users.get(w.pia.id)).toBeNull();
    expect(w.core.users.getByEmail('pia@x.y')).toBeNull();
    expect(references(w.core, w.pia.id)).toEqual([]);
    // Apps and instances are whole and now the administrator's, with their data, uploads, domain and shares to others.
    expect(w.core.apps.getApp('board')!.ownerId).toBe(w.admin.id);
    for (const slug of ['board', 'board-two', 'notes-pia']) expect(w.core.apps.getInstanceBySlug(slug)!.ownerId, slug).toBe(w.admin.id);
    const board = w.core.apps.getInstanceBySlug('board')!;
    expect(w.core.data.get(board.id, 'cards/a')!.data).toEqual({ text: 'kept' });
    expect(w.core.assets.list(board.id)).toHaveLength(1);
    expect(w.core.domains.list(board.id)).toEqual(['board.example.org']);
    expect(w.core.access.listGrants(board.id).map((g) => g.principalLabel)).toEqual(['uwe@x.y']);
    expect(w.core.apps.listCollaborators(w.core.apps.getApp('board')!.id)).toEqual([]);
    expect(w.core.access.levelFor(board, w.admin)).toBe('owner');
    expect(w.core.apps.readVersionHtml(board.appId, w.core.apps.getInstanceBySlug('board-two')!.activeVersion)).toBe('<p>saved</p>');
    // Nothing went to the trash, and the name she had retired is now reserved for the new owner.
    expect(trashNames(w.core)).toEqual(before);
    expect(() => w.core.apps.createInstance({ appId: board.appId, slug: 'board-old', ownerId: w.uwe.id })).toThrow(expect.objectContaining({ reason: 'slug_retired' }));
    expect(w.core.apps.createInstance({ appId: board.appId, slug: 'board-old', ownerId: w.admin.id }).slug).toBe('board-old');
    // What she left in other people's things stays: the version she deployed (now the app owner's), the share she set up, her documents.
    const notes = w.core.apps.getInstanceBySlug('notes')!;
    expect(w.core.apps.listVersions(notes.appId).map((v) => v.createdBy)).toEqual([w.admin.id, w.admin.id]);
    expect(w.core.access.listGrants(notes.id).map((g) => g.principalLabel)).toEqual(['uwe@x.y']);
    expect(w.core.data.get(notes.id, 'notes/by-pia')).toMatchObject({ data: { text: 'stays' }, updatedBy: w.pia.id });
    expect(w.core.apps.getInstanceBySlug('notes-uwe')!.ownerId).toBe(w.uwe.id);
    // The other administrator's invitation and everything else are untouched.
    expect(w.core.accounts.listInvites().map((i) => i.email)).toEqual(['later@x.y']);
    expect(w.core.groups.list().map((g) => g.memberCount)).toEqual([0]);
    expect(w.core.users.list().map((u) => u.email).sort()).toEqual(['admin@x.y', 'boss@x.y', 'guest@x.y', 'uwe@x.y']);
  });

  it('delete: apps and instances go to the trash through the delete hooks, and no row names the deleted one', async () => {
    const w = await world();
    // Nobody else may have an instance of her app for this; her own app has only her instances.
    const ids = Object.fromEntries(['board', 'board-two', 'notes-pia'].map((slug) => [slug, w.core.apps.getInstanceBySlug(slug)!.id]));
    const boardApp = w.core.apps.getApp('board')!.id;
    const res = await w.post(`/admin/users/${w.pia.id}/delete`, { owned: 'delete', transfer_to: 'admin@x.y', confirm: 'pia@x.y' });
    expect(res.status).toBe(200);
    expect(res.text).toContain(en('admin.users.delete.done', { email: 'pia@x.y' }));

    expect(w.core.users.get(w.pia.id)).toBeNull();
    expect(references(w.core, w.pia.id)).toEqual([]);
    expect(w.core.apps.getApp('board')).toBeNull();
    for (const slug of Object.keys(ids)) expect(w.core.apps.getInstanceBySlug(slug), slug).toBeNull();
    // The delete hooks ran: custom domain gone, data in the trash, the app's files too.
    expect(w.core.domains.instanceIdFor('board.example.org')).toBeNull();
    const trash = trashNames(w.core);
    for (const id of [ids.board, ids['notes-pia']]) expect(trash.some((n) => n.startsWith(`${id}-`)), id).toBe(true);
    expect(trash.some((n) => n.startsWith(`app-${boardApp}-`))).toBe(true);
    expect(fs.existsSync(path.join(w.core.config.dataDir, 'apps', boardApp))).toBe(false);
    expect(fs.existsSync(path.join(w.core.config.dataDir, 'instances', ids.board))).toBe(false);
    // The names stay reserved, now for the administrator who deleted the account.
    const notes = w.core.apps.getInstanceBySlug('notes')!;
    expect(() => w.core.apps.createInstance({ appId: notes.appId, slug: 'board-two', ownerId: w.uwe.id })).toThrow(expect.objectContaining({ reason: 'slug_retired' }));
    expect(w.core.apps.createInstance({ appId: notes.appId, slug: 'board-two', ownerId: w.admin.id }).slug).toBe('board-two');
    // Other people's apps and instances are untouched.
    expect(w.core.apps.listVersions(notes.appId)).toHaveLength(2);
    expect(w.core.apps.getInstanceBySlug('notes-uwe')!.ownerId).toBe(w.uwe.id);
    expect(w.core.data.get(notes.id, 'notes/by-pia')).toMatchObject({ data: { text: 'stays' } });
  });

  it('the saved pages of a deleted instance in someone else\'s app go to the trash', async () => {
    const w = await world();
    const notes = w.core.apps.getApp('notes')!;
    const mine = w.core.apps.getInstanceBySlug('notes-pia')!;
    w.core.users.setDisabled(w.pia.id, false);
    const saved = w.core.apps.selfPublish({ instanceId: mine.id, html: '<p>my page</p>', baseVersion: mine.activeVersion, userId: w.pia.id }).version.number;
    w.core.users.setDisabled(w.pia.id, true);
    w.core.removal.remove(w.pia.id, w.admin, { delete: true });
    expect(w.core.apps.getVersion(notes.id, saved)).toBeNull();
    expect(trashNames(w.core).some((n) => n.startsWith(`version-${notes.id}-${saved}-`))).toBe(true);
    expect(references(w.core, w.pia.id)).toEqual([]);
  });

  it('her credentials stop working: session, API token and OAuth token', async () => {
    const w = await world();
    const hh = h!;
    w.core.users.setDisabled(w.pia.id, false);
    const session = await hh.login('pia@x.y', PASSWORD);
    const api = w.core.tokens.create(w.pia.id, 'ci').token;
    const oauth = w.core.oauth.issueTokens('c1', w.pia.id, 'grant-2', 'mcp', null).access_token;
    const calls = (): Promise<number[]> => Promise.all([
      request(hh.app).get('/').set('Host', hh.host).set('Cookie', session).then((r) => r.status),
      request(hh.app).get('/api/apps').set('Host', hh.host).set('Authorization', `Bearer ${api}`).then((r) => r.status),
      request(hh.app).get('/api/apps').set('Host', hh.host).set('Authorization', `Bearer ${oauth}`).then((r) => r.status),
    ]);
    expect(await calls()).toEqual([200, 200, 200]);
    w.core.users.setDisabled(w.pia.id, true);
    w.core.oauth.issueTokens('c1', w.pia.id, 'grant-3', 'mcp', null);
    w.core.removal.remove(w.pia.id, w.admin, { transferTo: w.admin.id });
    expect(await calls()).toEqual([302, 401, 401]);
    expect(w.core.oauth.verifyAccessToken(oauth)).toBeNull();
    // The address is free again: a new account with it starts with nothing.
    const again = w.core.users.create({ email: 'pia@x.y', name: 'New Pia', password: PASSWORD, role: 'publisher' });
    expect(again.id).not.toBe(w.pia.id);
    expect(w.core.apps.listAppsFor(again.id)).toEqual([]);
    expect(w.core.access.sharedWith(again)).toEqual([]);
  });

  describe('refusals leave everything as it was', () => {
    const untouched = (w: World): void => {
      expect(w.core.users.get(w.pia.id)).not.toBeNull();
      expect(w.core.apps.getApp('board')!.ownerId).toBe(w.pia.id);
      expect(w.core.apps.listInstancesOwnedBy(w.pia.id)).toHaveLength(3);
      expect(w.core.tokens.list(w.pia.id)).toHaveLength(1);
      expect(w.core.groups.list()[0].memberCount).toBe(1);
    };
    const ok = { owned: 'transfer', transfer_to: 'admin@x.y', confirm: 'pia@x.y' };

    it('an account that is still active must be deactivated first: page and deletion are refused', async () => {
      const w = await world();
      w.core.users.setDisabled(w.pia.id, false);
      for (const res of [await w.get(`/admin/users/${w.pia.id}/delete`), await w.post(`/admin/users/${w.pia.id}/delete`, ok)]) {
        expect(res.status).toBe(409);
        expect(res.text).toContain(en('admin.users.delete.active'));
      }
      untouched(w);
      // That also covers every active administrator, the last one included.
      const boss = await w.post(`/admin/users/${w.boss.id}/delete`, { confirm: 'boss@x.y' });
      expect(boss.status).toBe(409);
      expect(w.core.users.get(w.boss.id)).not.toBeNull();
      expect(() => w.core.removal.remove(w.boss.id, w.admin, { delete: true })).toThrow(expect.objectContaining({ reason: 'delete_active' }));
    });

    it('nobody deletes their own account, and the last active administrator cannot be deactivated to get there', async () => {
      const w = await world();
      const self = await w.post(`/admin/users/${w.admin.id}/delete`, { confirm: 'admin@x.y' });
      expect(self.status).toBe(409);
      expect(self.text).toContain(en('admin.users.delete.self'));
      expect((await w.get(`/admin/users/${w.admin.id}/delete`)).status).toBe(409);
      expect(w.core.users.get(w.admin.id)).not.toBeNull();
      // With the other administrator gone, the one left can neither be deactivated nor, therefore, deleted.
      w.core.users.setDisabled(w.boss.id, true);
      expect((await w.post(`/admin/users/${w.boss.id}/delete`, { confirm: 'boss@x.y' })).status).toBe(200);
      expect((await w.post(`/admin/users/${w.admin.id}/disabled`, { disabled: '1' })).status).toBe(409);
      expect(w.core.users.list().filter((u) => u.role === 'admin' && !u.disabled).map((u) => u.email)).toEqual(['admin@x.y']);
    });

    it('a wrong or missing confirmation', async () => {
      const w = await world();
      for (const confirm of ['', 'pia', 'PIA@x.y', 'admin@x.y']) {
        const res = await w.post(`/admin/users/${w.pia.id}/delete`, { ...ok, confirm });
        expect(res.status, confirm).toBe(400);
        expect(res.text, confirm).toContain(en('admin.users.delete.confirmWrong'));
        // The page is shown again, ready for another try.
        expect(res.text).toContain(`action="/admin/users/${w.pia.id}/delete"`);
      }
      untouched(w);
    });

    it('no choice, or a transfer to nobody, to a deactivated account or to the account itself', async () => {
      const w = await world();
      const off = w.core.users.create({ email: 'off@x.y', name: 'Off', password: PASSWORD, role: 'publisher' });
      w.core.users.setDisabled(off.id, true);
      const cases: Array<[Record<string, string>, MessageKey]> = [
        [{ confirm: 'pia@x.y' }, 'admin.users.delete.choose'],
        [{ ...ok, owned: 'everything' }, 'admin.users.delete.choose'],
        [{ ...ok, transfer_to: '' }, 'admin.users.delete.target'],
        [{ ...ok, transfer_to: 'nobody@x.y' }, 'admin.users.delete.target'],
        [{ ...ok, transfer_to: 'off@x.y' }, 'admin.users.delete.target'],
        [{ ...ok, transfer_to: 'pia@x.y' }, 'admin.users.delete.target'],
      ];
      for (const [body, key] of cases) {
        const res = await w.post(`/admin/users/${w.pia.id}/delete`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.text, JSON.stringify(body)).toContain(en(key));
      }
      untouched(w);
    });

    it('apps can only go to an administrator or a publisher; instances alone can go to anyone', async () => {
      const w = await world();
      const res = await w.post(`/admin/users/${w.pia.id}/delete`, { ...ok, transfer_to: 'uwe@x.y' });
      expect(res.status).toBe(400);
      expect(res.text).toContain(en('admin.users.delete.targetRole'));
      untouched(w);
      // Uwe owns one instance and no app: a plain user can take that over.
      w.core.users.setDisabled(w.uwe.id, true);
      const plain = w.core.users.create({ email: 'plain@x.y', name: 'Plain', password: PASSWORD, role: 'user' });
      expect((await w.post(`/admin/users/${w.uwe.id}/delete`, { owned: 'transfer', transfer_to: 'plain@x.y', confirm: 'uwe@x.y' })).status).toBe(200);
      expect(w.core.apps.getInstanceBySlug('notes-uwe')!.ownerId).toBe(plain.id);
    });

    it('deleting is refused while other people have instances of one of the account\'s apps', async () => {
      const w = await world();
      const board = w.core.apps.getApp('board')!;
      w.core.apps.createInstance({ appId: board.id, slug: 'board-uwe', ownerId: w.uwe.id });
      const trash = trashNames(w.core);
      const res = await w.post(`/admin/users/${w.pia.id}/delete`, { ...ok, owned: 'delete' });
      expect(res.status).toBe(409);
      expect(res.text).toContain(en('admin.users.delete.othersInstances'));
      untouched(w);
      // Nothing was half done: all instances still answer and nothing moved to the trash.
      expect(w.core.apps.listInstances(board.id)).toHaveLength(3);
      expect(w.core.apps.getInstanceBySlug('notes-pia')).not.toBeNull();
      expect(trashNames(w.core)).toEqual(trash);
      expect(w.core.data.get(w.core.apps.getInstanceBySlug('board')!.id, 'cards/a')).not.toBeNull();
      // Handing the app over works, and Uwe keeps his instance.
      expect((await w.post(`/admin/users/${w.pia.id}/delete`, ok)).status).toBe(200);
      expect(w.core.apps.getInstanceBySlug('board-uwe')!.ownerId).toBe(w.uwe.id);
    });

    it('an unknown account, a missing or foreign CSRF token, and anyone who is not an administrator', async () => {
      const w = await world();
      const hh = h!;
      expect((await w.get('/admin/users/nope/delete')).status).toBe(404);
      const unknown = await w.post('/admin/users/nope/delete', ok);
      expect(unknown.status).toBe(404);
      expect(unknown.text).toContain(en('admin.users.notFound'));
      const noCsrf = await request(hh.app).post(`/admin/users/${w.pia.id}/delete`).set('Host', hh.host).set('Cookie', w.cookie).type('form').send(ok);
      expect(noCsrf.status).toBe(403);
      const uwe = { user: w.uwe, cookie: await hh.login('uwe@x.y', PASSWORD) };
      expect((await w.post(`/admin/users/${w.pia.id}/delete`, ok, uwe)).status).toBe(403);
      expect((await w.get(`/admin/users/${w.pia.id}/delete`, uwe.cookie)).status).toBe(403);
      expect((await request(hh.app).get(`/admin/users/${w.pia.id}/delete`).set('Host', hh.host)).status).toBe(302);
      expect(() => w.core.removal.remove(w.pia.id, w.uwe, { delete: true })).toThrow(expect.objectContaining({ code: 'forbidden' }));
      untouched(w);
    });

    it('a failure while removing the account rolls the transfer back', async () => {
      const w = await world();
      // A row the removal does not know about and the database will not orphan: the deletion fails at its last step.
      dbOf(w.core).exec('CREATE TABLE keepsakes (user_id TEXT NOT NULL REFERENCES users(id))');
      dbOf(w.core).prepare('INSERT INTO keepsakes (user_id) VALUES (?)').run(w.pia.id);
      expect(() => w.core.removal.remove(w.pia.id, w.admin, { transferTo: w.admin.id })).toThrow(/FOREIGN KEY/);
      untouched(w);
      expect(w.core.access.listGrants(w.core.apps.getInstanceBySlug('board')!.id)).toHaveLength(2);
    });
  });

  it('is not offered over REST or MCP', async () => {
    const w = await world();
    const hh = h!;
    const token = w.core.tokens.create(w.admin.id, 'admin').token;
    for (const [method, url] of [['delete', `/api/users/${w.pia.id}`], ['post', `/api/users/${w.pia.id}/delete`], ['delete', `/api/admin/users/${w.pia.id}`]] as const) {
      expect((await request(hh.app)[method](url).set('Host', hh.host).set('Authorization', `Bearer ${token}`)).status, url).toBe(404);
    }
    const tools = fs.readFileSync(new URL('../src/mcp/tools.ts', import.meta.url), 'utf8');
    expect(tools).not.toMatch(/removal\b|delete_user|delete_account/);
    expect(w.core.users.get(w.pia.id)).not.toBeNull();
  });
});
