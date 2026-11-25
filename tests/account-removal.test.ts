import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminExtension } from '../src/http/admin.js';
import { apiExtension } from '../src/http/api.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { esc } from '../src/http/pages.js';
import { loginLimiter } from '../src/http/platform.js';
import { csrfToken } from '../src/http/session.js';
import { LOCALES, t, type MessageKey } from '../src/i18n/index.js';
import { mcpExtension } from '../src/mcp/http.js';
import { createCore, type Core } from '../src/core.js';
import { PrivatePurge, PURGE_INSTANCES_PER_TURN } from '../src/data/private-purge.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness } from './support/http.js';

const PASSWORD = 'correct horse battery';
const en = (key: MessageKey, params?: Record<string, string | number>): string => esc(t('en', key, params));
let h: Harness | undefined;
afterEach(() => { vi.restoreAllMocks(); h?.core.close(); h = undefined; });

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
  // Her private area in someone else's instance, next to another person's and to paths that only look like hers.
  for (const p of [`data/users/${pia.id}/settings`, `data/users/${pia.id}/drafts/parts/b`, `data/users/${uwe.id}/settings`, `data/users/${pia.id}x/settings`, `datax/users/${pia.id}/settings`]) {
    core.data.set(notes.instances[0].id, p, { mine: true }, pia.id);
  }
  // She agreed to be known to an instance she reaches through its visibility alone.
  const open = core.apps.deploy({ slug: 'open', html: '<p>open</p>', userId: boss.id, capabilities: { user: {} } });
  core.apps.setVisibility(open.instances[0].id, 'users', boss.id);
  core.access.confirmSignIn(open.instances[0], pia, true);
  core.access.confirmSignIn(open.instances[0], uwe, false);

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
    request(hh.app).post(p).set('Host', hh.host).set('Cookie', as.cookie).type('form').send({ csrf: csrfToken(core, as.user), decision: 'delete', ...body });
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
      'instance_signins.user_id', 'instances.owner_id', 'oauth_codes.user_id', 'oauth_tokens.user_id', 'retired_slugs.owner_id', 'users.id', 'versions.created_by',
    ]);
    expect(dbOf(w.core).prepare('SELECT ai_group_id FROM users WHERE id = ?').get(w.pia.id)).not.toEqual({ ai_group_id: null });
  });

  it('the page of an account offers "Delete account" for a deactivated account only, and never for oneself', async () => {
    const w = await world();
    const deleteLinks = async (id: string): Promise<Element[]> =>
      [...new JSDOM((await w.get(`/admin/users/${id}`)).text).window.document.querySelectorAll('main a[href$="/delete"]')];
    const links = await deleteLinks(w.pia.id);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/admin/users/${w.pia.id}/delete`]);
    expect(links[0].textContent).toBe(t('en', 'admin.users.delete'));
    // An active account says why it cannot be deleted yet; one's own account offers neither.
    expect(await deleteLinks(w.uwe.id)).toEqual([]);
    expect((await w.get(`/admin/users/${w.uwe.id}`)).text).toContain(t('en', 'admin.users.delete.active'));
    expect(await deleteLinks(w.admin.id)).toEqual([]);
    // The list itself only leads to each account's page.
    const list = new JSDOM((await w.get('/admin/users')).text).window.document;
    expect(list.querySelectorAll('main a[href$="/delete"]')).toHaveLength(0);
    expect(list.querySelector(`main a[href="/admin/users/${w.pia.id}"]`)!.getAttribute('aria-label')).toBe(t('en', 'card.manage', { title: 'pia@x.y' }));
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
    const radios = [...form.querySelectorAll<HTMLInputElement>('fieldset input[type="radio"][name="owned"]')];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([['transfer', true], ['delete', false]]);
    expect(form.querySelector('fieldset > legend')!.textContent).toBe(t('en', 'admin.users.delete.what'));
    expect(form.querySelector('[role="radiogroup"]')).toBeNull();
    // Deleting is never what Enter does: the first submit button of the form, its default, is Cancel.
    const buttons = [...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')];
    expect(buttons.map((b) => [b.name, b.value, b.textContent])).toEqual([['decision', 'cancel', t('en', 'signin.cancel')], ['decision', 'delete', t('en', 'admin.users.delete.submit')]]);
    expect(buttons[0].hasAttribute('formnovalidate')).toBe(true);
    expect(buttons[1].classList.contains('btn-danger')).toBe(true);
    // The acting administrator is the default heir; every control has a label and is reachable without script.
    expect(form.querySelector<HTMLInputElement>('input[name="transfer_to"]')!.value).toBe('admin@x.y');
    expect(form.querySelector('input[name="confirm"]')!.getAttribute('data-confirm')).toBe('pia@x.y');
    for (const input of form.querySelectorAll('input:not([type="hidden"])')) {
      expect(input.closest('label') ?? doc.querySelector(`label[for="${input.id}"]`), input.getAttribute('name')!).not.toBeNull();
    }
    expect(res.text).toContain(en('admin.users.delete.text', { name: 'Pia', email: 'pia@x.y' }));

    // An account that owns nothing is not asked the question.
    w.core.users.setDisabled(w.uwe.id, true);
    w.core.apps.deleteInstance(w.core.apps.getInstanceBySlug('notes-uwe')!.id, w.uwe.id);
    const empty = await w.get(`/admin/users/${w.uwe.id}/delete`);
    expect(empty.text).toContain(en('admin.users.delete.ownsNothing'));
    expect(empty.text).not.toContain('name="owned"');
  });

  it('Cancel, the default answer of the form, deletes nothing, with or without the rest filled in', async () => {
    const w = await world();
    for (const body of [{ decision: 'cancel' }, { decision: 'cancel', owned: 'delete', confirm: 'pia@x.y' }, { decision: '', owned: 'delete', confirm: 'pia@x.y' }]) {
      const res = await w.post(`/admin/users/${w.pia.id}/delete`, body);
      expect(res.status).toBe(302);
      // Back to the account's page, where the way to this question started.
      expect(res.headers.location).toBe(`/admin/users/${w.pia.id}`);
    }
    expect(w.core.users.get(w.pia.id)).not.toBeNull();
    expect(w.core.apps.getApp('board')).not.toBeNull();
    // Cancel for an account that no longer exists goes to the list.
    const gone = await w.post('/admin/users/nope/delete', { decision: 'cancel' });
    expect(gone.headers.location).toBe('/admin/users');
  });

  it('one’s own page sends to the account page and offers neither deactivating nor deleting', async () => {
    const w = await world();
    const doc = new JSDOM((await w.get(`/admin/users/${w.admin.id}`)).text).window.document;
    const main = doc.querySelector('main')!;
    expect(main.textContent).toContain(t('en', 'admin.users.self'));
    expect(main.querySelector('a[href="/account"]')).not.toBeNull();
    expect(main.querySelector('form[action$="/disabled"], a[href$="/delete"], form[action$="/reset-link"]')).toBeNull();
    // Role and AI group stay: the server refuses demoting the last administrator.
    expect(main.querySelector(`form[action="/admin/users/${w.admin.id}/role"]`)).not.toBeNull();
  });

  it('the script disables the delete button until the address is typed and leaves Cancel alone', async () => {
    const w = await world();
    const html = (await w.get(`/admin/users/${w.pia.id}/delete`)).text;
    const dom = new JSDOM(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    const doc = dom.window.document;
    const [cancel, del] = [...doc.querySelectorAll<HTMLButtonElement>('form[action$="/delete"] button[type="submit"]')];
    expect([cancel.disabled, del.disabled]).toEqual([false, true]);
    const input = doc.querySelector<HTMLInputElement>('input[name="confirm"]')!;
    input.value = 'pia@x.y';
    input.dispatchEvent(new dom.window.Event('input'));
    expect([cancel.disabled, del.disabled]).toEqual([false, false]);
  });

  it('a refused attempt comes back with the choice and the target that were sent, not with the defaults', async () => {
    const w = await world();
    const sent = async (body: Record<string, string>): Promise<{ transfer: boolean; trash: boolean; to: string }> => {
      const res = await w.post(`/admin/users/${w.pia.id}/delete`, { confirm: 'typo', ...body });
      expect(res.status).toBe(400);
      const doc = new JSDOM(res.text).window.document;
      const radio = (v: string): boolean => doc.querySelector<HTMLInputElement>(`input[name="owned"][value="${v}"]`)!.checked;
      return { transfer: radio('transfer'), trash: radio('delete'), to: doc.querySelector<HTMLInputElement>('input[name="transfer_to"]')!.value };
    };
    // Chose to delete, mistyped the address: the retry must not quietly become a transfer to the administrator.
    expect(await sent({ owned: 'delete', transfer_to: 'admin@x.y' })).toEqual({ transfer: false, trash: true, to: 'admin@x.y' });
    expect(await sent({ owned: 'transfer', transfer_to: 'boss@x.y' })).toEqual({ transfer: true, trash: false, to: 'boss@x.y' });
    expect(await sent({ owned: 'transfer', transfer_to: '"><b>x' })).toEqual({ transfer: true, trash: false, to: '"><b>x' });
    expect(await sent({ owned: 'transfer', transfer_to: '' })).toEqual({ transfer: true, trash: false, to: '' });
    // Nothing chosen and nothing entered: the defaults.
    expect(await sent({ owned: 'neither' })).toEqual({ transfer: true, trash: false, to: 'admin@x.y' });
    // The same after a refusal that is about the target itself.
    const target = await w.post(`/admin/users/${w.pia.id}/delete`, { owned: 'transfer', transfer_to: 'nobody@x.y', confirm: 'pia@x.y' });
    expect(new JSDOM(target.text).window.document.querySelector<HTMLInputElement>('input[name="transfer_to"]')!.value).toBe('nobody@x.y');
    expect(w.core.users.get(w.pia.id)).not.toBeNull();
  });

  it('her agreements to sign in to instances go with her, other people\'s stay', async () => {
    const w = await world();
    const rows = (): string[] => (dbOf(w.core).prepare('SELECT user_id FROM instance_signins ORDER BY user_id').all() as Array<{ user_id: string }>).map((r) => r.user_id);
    expect(rows()).toEqual([w.pia.id, w.uwe.id].sort());
    expect(dbOf(w.core).prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    w.core.removal.remove(w.pia.id, w.admin, { transferTo: w.admin.id });
    expect(rows()).toEqual([w.uwe.id]);
  });

  it('her private areas in other people\'s instances are removed; everything else there stays', async () => {
    const w = await world();
    const notes = w.core.apps.getInstanceBySlug('notes')!;
    const paths = (): string[] => [...w.core.data.exportDocs(notes.id, { includePrivateOf: w.pia.id })].map((d) => d.path)
      .concat([...w.core.data.exportDocs(notes.id, { includePrivateOf: w.uwe.id })].map((d) => d.path).filter((p) => p.startsWith('data/users/')));
    expect(paths().filter((p) => p.startsWith(`data/users/${w.pia.id}/`))).toHaveLength(2);
    const before = w.core.data.usage(notes.id);
    expect(w.core.removal.remove(w.pia.id, w.admin, { transferTo: w.admin.id })).toEqual({ cleanedUp: true });
    // Not within the administrator's request: the pass over every instance runs afterwards.
    expect(paths().filter((p) => p.startsWith(`data/users/${w.pia.id}/`))).toHaveLength(2);
    await w.core.privatePurge.idle();
    expect(paths().sort()).toEqual([`data/users/${w.uwe.id}/settings`, `datax/users/${w.pia.id}/settings`, 'notes/by-pia'].sort());
    // Paths that merely look like hers are nobody's private area and are not touched.
    for (const p of [`data/users/${w.pia.id}x/settings`, `datax/users/${w.pia.id}/settings`]) expect(w.core.data.get(notes.id, p), p).not.toBeNull();
    expect(w.core.data.usage(notes.id)).toBeLessThanOrEqual(before);
    // Bounded per call: a huge area goes in steps, and the count says how much went.
    const own = w.core.apps.getInstanceBySlug('board')!;
    for (let i = 0; i < 5; i++) w.core.data.set(own.id, `data/users/gone/i${i}`, { i }, null);
    expect(w.core.data.purgePrivateArea(own.id, 'gone', 3)).toBe(3);
    expect(w.core.data.purgePrivateArea(own.id, 'gone', 3)).toBe(2);
    expect(w.core.data.purgePrivateArea(own.id, 'gone', 3)).toBe(0);
    expect(w.core.data.purgePrivateArea('00000000-0000-4000-8000-000000000000', 'gone')).toBe(0);
  });

  describe('the pass over every instance', () => {
    const quiet = (): { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void; lines: string[]; errors: unknown[][] } => {
      const lines: string[] = [];
      const errors: unknown[][] = [];
      return { lines, errors, log: (...a) => { lines.push(String(a[0])); }, error: (...a) => { errors.push(a); } };
    };
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `i${i}`);
    /** Records what else gets a turn of the event loop while a pass runs. */
    const ticking = (into: string[], until: () => boolean, each?: () => void): void => {
      const tick = (): void => { if (until()) return; into.push('tick'); each?.(); setImmediate(tick); };
      setImmediate(tick);
    };

    it('an area larger than one call removes is continued until nothing is left', async () => {
      const w = await world();
      const board = w.core.apps.getInstanceBySlug('board')!;
      for (let i = 0; i < 8; i++) w.core.data.set(board.id, `data/users/gone/i${i}`, { i }, null);
      w.core.data.set(board.id, 'data/users/gonex/keep', {}, null);
      const calls: number[] = [];
      const out = quiet();
      const purge = new PrivatePurge((instanceId, userId) => { const n = w.core.data.purgePrivateArea(instanceId, userId, 3); calls.push(n); return n; }, 3, out);
      purge.start('gone', [board.id]);
      // Nothing happens before the caller's own turn is over.
      expect(calls).toEqual([]);
      await purge.idle();
      expect(calls).toEqual([3, 3, 2]);
      expect(w.core.data.purgePrivateArea(board.id, 'gone')).toBe(0);
      expect(w.core.data.get(board.id, 'data/users/gonex/keep')).not.toBeNull();
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toContain('8 documents in 1 instances');
      expect(out.errors).toEqual([]);
    });

    it(`lets other work run after every ${PURGE_INSTANCES_PER_TURN} instances and between two calls on one instance`, async () => {
      const order: string[] = [];
      let done = false;
      let big = 2;
      const purge = new PrivatePurge((instanceId) => { order.push(instanceId); return instanceId === 'i3' && big-- > 0 ? 5 : 0; }, 5, quiet());
      purge.start('gone', ids(2 * PURGE_INSTANCES_PER_TURN + 5));
      ticking(order, () => done);
      await purge.idle();
      done = true;
      const runs = order.join(' ').split('tick').map((r) => r.trim().split(' ').filter(Boolean));
      // i3 is called three times, with a turn for everyone else between the calls; then the rest of its ten, then ten, then five.
      expect(runs.filter((r) => r.length > 0).map((r) => r.length)).toEqual([4, 1, 7, PURGE_INSTANCES_PER_TURN, 5]);
      expect(order.filter((o) => o === 'i3')).toHaveLength(3);
      expect(order.filter((o) => o !== 'tick' && o !== 'i3')).toEqual(ids(2 * PURGE_INSTANCES_PER_TURN + 5).filter((i) => i !== 'i3'));
    });

    it('stops between two calls at shutdown, says so once, and a failure in one instance does not keep it from the others', async () => {
      const seen: string[] = [];
      const out = quiet();
      const purge = new PrivatePurge((instanceId) => { seen.push(instanceId); return 0; }, 5, out);
      purge.start('gone', ids(3 * PURGE_INSTANCES_PER_TURN));
      let stopped = false;
      ticking([], () => stopped, () => { stopped = true; purge.stop(); });
      await purge.idle();
      expect(seen).toEqual(ids(PURGE_INSTANCES_PER_TURN));
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toMatch(/interrupted by the shutdown after 10 of 30 instances.*not continued after a restart/);
      expect(out.errors).toEqual([]);

      const failing = quiet();
      const visited: string[] = [];
      const second = new PrivatePurge((instanceId) => { visited.push(instanceId); if (instanceId === 'i1' || instanceId === 'i2') throw new Error(`broken ${instanceId}`); return 1; }, 5, failing);
      second.start('gone', ids(4));
      await second.idle();
      expect(visited).toEqual(ids(4));
      expect(failing.lines).toEqual([]);
      expect(failing.errors).toHaveLength(1);
      expect(String(failing.errors[0][0])).toContain('failed in 2 of 4 instances');
      expect(failing.errors[0][1]).toEqual(new Error('broken i1'));
    });

    it('closing the server while a pass waits for its turn touches no database afterwards', async () => {
      const w = await world();
      const notes = w.core.apps.getInstanceBySlug('notes')!;
      const purged = vi.spyOn(w.core.data, 'purgePrivateArea');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      w.core.removal.remove(w.pia.id, w.admin, { transferTo: w.admin.id });
      w.core.close();
      const dataDir = w.core.config.dataDir;
      h = undefined;
      await w.core.privatePurge.idle();
      expect(purged).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('interrupted by the shutdown'))).toHaveLength(1);
      // What it had not reached is still there, and nothing takes it up at the next start.
      const again = createCore({ ...w.core.config, dataDir });
      try {
        await again.privatePurge.idle();
        expect([...again.data.exportDocs(notes.id, { includePrivateOf: w.pia.id })].filter((d) => d.path.startsWith(`data/users/${w.pia.id}/`))).toHaveLength(2);
      } finally { again.close(); }
    });
  });

  it('when moving the files to the trash fails, the account is still gone and the administrator is told to look at the log', async () => {
    const w = await world();
    // A file where the trash directory belongs: nothing can be moved there.
    const trash = path.join(w.core.config.dataDir, 'trash');
    fs.rmSync(trash, { recursive: true, force: true });
    fs.writeFileSync(trash, 'in the way');
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let res: request.Response;
    try {
      res = await w.post(`/admin/users/${w.pia.id}/delete`, { owned: 'delete', confirm: 'pia@x.y' });
    } finally { console.error = original; }
    // The answer is a redirect to the list, which says what happened.
    expect(res.status).toBe(302);
    const page = await w.get(res.headers.location as string);
    expect(page.headers['content-type']).toMatch(/html/);
    const doc = new JSDOM(page.text).window.document;
    expect(doc.querySelector('[role="alert"]')!.textContent).toBe(t('en', 'admin.users.delete.cleanupFailed', { email: 'pia@x.y' }));
    expect(res.text).not.toContain(en('admin.users.delete.done', { email: 'pia@x.y' }));
    expect(doc.querySelector('table')).not.toBeNull();
    expect(errors.some((args) => String(args[0]).includes(`the account ${w.pia.id} was deleted, but cleaning up after it failed`))).toBe(true);
    // The database side is complete, and what does not need the trash was still done.
    expect(w.core.users.get(w.pia.id)).toBeNull();
    expect(references(w.core, w.pia.id)).toEqual([]);
    expect(w.core.apps.getApp('board')).toBeNull();
    expect(w.core.domains.instanceIdFor('board.example.org')).toBeNull();
    expect([...w.core.data.exportDocs(w.core.apps.getInstanceBySlug('notes')!.id, { includePrivateOf: w.pia.id })].map((d) => d.path)).toEqual([`datax/users/${w.pia.id}/settings`, 'notes/by-pia']);
  });

  it('a pause the address collected at the sign-in page ends with the account', async () => {
    const w = await world();
    const limiter = loginLimiter(w.core);
    for (let i = 0; i < 30 && !limiter.accountPaused('pia@x.y'); i++) limiter.begin(`10.0.${i}.1`, 'pia@x.y', false);
    expect(limiter.accountPaused('pia@x.y')).toBe(true);
    expect((await w.post(`/admin/users/${w.pia.id}/delete`, { owned: 'transfer', transfer_to: 'admin@x.y', confirm: 'pia@x.y' })).status).toBe(302);
    expect(limiter.accountPaused('pia@x.y')).toBe(false);
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
    expect(res.status).toBe(302);
    const page = await w.get(res.headers.location as string);
    expect(page.text).toContain(en('admin.users.delete.done', { email: 'pia@x.y' }));
    expect(page.text).not.toContain(`/admin/users/${w.pia.id}`);

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
    expect(res.status).toBe(302);
    expect((await w.get(res.headers.location as string)).text).toContain(en('admin.users.delete.done', { email: 'pia@x.y' }));

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
      expect((await w.post(`/admin/users/${w.boss.id}/delete`, { owned: 'transfer', transfer_to: 'admin@x.y', confirm: 'boss@x.y' })).status).toBe(302);
      expect((await w.post(`/admin/users/${w.admin.id}/disabled`, { disabled: '1' })).status).toBe(403);
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
      expect((await w.post(`/admin/users/${w.uwe.id}/delete`, { owned: 'transfer', transfer_to: 'plain@x.y', confirm: 'uwe@x.y' })).status).toBe(302);
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
      expect((await w.post(`/admin/users/${w.pia.id}/delete`, ok)).status).toBe(302);
      expect(w.core.apps.getInstanceBySlug('board-uwe')!.ownerId).toBe(w.uwe.id);
    });

    it('an unknown account, a missing or foreign CSRF token, and anyone who is not an administrator', async () => {
      const w = await world();
      const hh = h!;
      expect((await w.get('/admin/users/nope/delete')).status).toBe(404);
      const unknown = await w.post('/admin/users/nope/delete', ok);
      expect(unknown.status).toBe(404);
      expect(unknown.text).toContain(en('admin.users.notFound'));
      const noCsrf = await request(hh.app).post(`/admin/users/${w.pia.id}/delete`).set('Host', hh.host).set('Cookie', w.cookie).type('form').send({ ...ok, decision: 'delete' });
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
