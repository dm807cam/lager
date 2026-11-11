import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { apiExtension } from '../src/http/api.js';
import { mcpExtension } from '../src/mcp/http.js';
import { makeHarness, type Harness } from './support/http.js';

interface Running { h: Harness; server: http.Server; base: string; token: string }
let running: Running | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  if (running) {
    running.server.closeAllConnections();
    await new Promise((r) => running!.server.close(r));
    running.h.core.close();
    running = undefined;
  }
});

async function start(instanceQuotaBytes?: number): Promise<Running> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const h = makeHarness({ publicUrl: `http://127.0.0.1:${port}`, extensions: [apiExtension, mcpExtension], instanceQuotaBytes });
  server.on('request', h.app);
  running = { h, server, base: `http://127.0.0.1:${port}`, token: h.core.tokens.create(h.adminId, 'mcp').token };
  return running;
}

async function connect(r: Running, token = r.token): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${r.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Calls a tool and parses its single JSON text block. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; json: any }> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return { isError: res.isError === true, json: JSON.parse(content[0].text) };
}

const guide = fs.readFileSync(new URL('../src/guide.md', import.meta.url), 'utf8');

describe('mcp endpoint', () => {
  it('lists the twenty-one tools and exposes instructions', async () => {
    const r = await start();
    const client = await connect(r);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'activate_version', 'add_domain', 'check_artifact', 'create_instance', 'db_read', 'db_write', 'deploy_app', 'export_data', 'get_app', 'get_guide',
      'import_data', 'list_apps', 'list_shares', 'list_snapshots', 'remove_domain', 'restore_snapshot', 'set_app_icon', 'set_auto_update', 'set_visibility', 'share_instance', 'unshare_instance',
    ]);
    expect(client.getServerVersion()?.name).toBe('lager');
    const firstSection = guide.split(/\r?\n---\r?\n/)[0].trim();
    expect(client.getInstructions()?.trim()).toBe(firstSection);
    expect(firstSection.split('\n').length).toBeLessThanOrEqual(15);
    const g = await call(client, 'get_guide');
    expect(g.json.guide).toBe(guide);
  });

  it('deploy_app then get_app', async () => {
    const r = await start();
    const client = await connect(r);
    const dep = await call(client, 'deploy_app', { slug: 'todo', html: '<p>todo</p>', title: 'Todo', capabilities: { db: {} }, note: 'n1' });
    expect(dep.isError).toBe(false);
    const app0 = r.h.core.apps.getApp('todo')!;
    expect(dep.json).toEqual({
      app: 'todo', version: 1, createdVersion: true, urls: [`http://todo.apps.localhost:${new URL(r.base).port}`], pinned: [],
      warnings: ['No icon supplied; a generated one is used. Pass icon_svg to set your own.'],
      description: '', themeColor: '#1f2a5c', iconUrl: `${r.base}/app-icons/${app0.id}/${app0.iconVersion}/192.png`,
    });
    const got = await call(client, 'get_app', { slug: 'todo' });
    expect(got.json).toMatchObject({ slug: 'todo', title: 'Todo', latestVersion: 1, instances: [{ slug: 'todo', activeVersion: 1, visibility: 'private' }] });
    expect(got.json.versions).toEqual([expect.objectContaining({ number: 1, note: 'n1' })]);
    const list = await call(client, 'list_apps');
    expect(list.json.apps.map((a: { slug: string }) => a.slug)).toEqual(['todo']);
    const missing = await call(client, 'get_app', { slug: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.json.error.code).toBe('not_found');
  });

  it('deploy_app surfaces lint warnings', async () => {
    const r = await start();
    const client = await connect(r);
    const dep = await call(client, 'deploy_app', { slug: 'ls', html: '<script>localStorage.setItem("a","b")</script>' });
    expect(dep.isError).toBe(false);
    expect(dep.json.warnings).toHaveLength(2);
    expect(dep.json.warnings[0]).toContain('localStorage');
  });

  it('activate_version rolls back', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>2</p>' });
    const act = await call(client, 'activate_version', { instance: 'todo', version: 1 });
    expect(act.isError).toBe(false);
    expect(act.json).toMatchObject({ slug: 'todo', activeVersion: 1 });
    expect(r.h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(1);

    const inst = await call(client, 'create_instance', { app: 'todo', slug: 'todo-b', visibility: 'users' });
    expect(inst.json).toMatchObject({ slug: 'todo-b', activeVersion: 2, visibility: 'users' });
    const vis = await call(client, 'set_visibility', { instance: 'todo-b', visibility: 'public' });
    expect(vis.json.visibility).toBe('public');
  });

  it('db_write then db_read', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>', capabilities: { db: {} } });
    const w = await call(client, 'db_write', {
      instance: 'todo',
      ops: [
        { op: 'set', path: 'tasks/t1', data: { title: 'A', n: 1 } },
        { op: 'set', path: 'tasks/t2', data: { title: 'B', n: 2 } },
        { op: 'update', path: 'tasks/t1', data: { done: true } },
        { op: 'set', path: 'tasks/t3', data: {} },
        { op: 'delete', path: 'tasks/t3' },
      ],
    });
    expect(w.isError).toBe(false);
    expect(w.json).toEqual({ applied: 5 });
    const doc = await call(client, 'db_read', { instance: 'todo', path: 'tasks/t1' });
    expect(doc.json.doc.data).toEqual({ title: 'A', n: 1, done: true });
    const coll = await call(client, 'db_read', { instance: 'todo', path: 'tasks', orderBy: [['n', 'desc']], limit: 1 });
    expect(coll.json.docs.map((d: { id: string }) => d.id)).toEqual(['t2']);
    const filtered = await call(client, 'db_read', { instance: 'todo', path: 'tasks', where: [['done', '==', true]] });
    expect(filtered.json.docs.map((d: { id: string }) => d.id)).toEqual(['t1']);

    const tooMany = await client.callTool({
      name: 'db_write', arguments: { instance: 'todo', ops: Array.from({ length: 101 }, (_, i) => ({ op: 'set', path: `x/${i}`, data: {} })) },
    });
    expect(tooMany.isError).toBe(true);
    expect(r.h.core.data.get(r.h.core.apps.getInstanceBySlug('todo')!.id, 'x/0')).toBeNull();
    const badPath = await call(client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'a//b', data: {} }] });
    expect(badPath.isError).toBe(true);
    expect(badPath.json.error.code).toBe('invalid_argument');
  });

  it('db_read refuses another user\'s private area', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const inst = r.h.core.apps.getInstanceBySlug('todo')!;
    r.h.core.data.set(inst.id, 'data/users/someone/settings', { secret: 1 }, 'someone');
    const read = await call(client, 'db_read', { instance: 'todo', path: 'data/users/someone/settings' });
    expect(read.isError).toBe(true);
    expect(read.json.error.code).toBe('forbidden');
    const query = await call(client, 'db_read', { instance: 'todo', path: 'data/users/someone' });
    expect(query.isError).toBe(true);
    const write = await call(client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'data/users/someone/settings', data: {} }] });
    expect(write.isError).toBe(true);
    expect(r.h.core.data.get(inst.id, 'data/users/someone/settings')!.data).toEqual({ secret: 1 });
    // the owner's own private area is fine
    const own = await call(client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: `data/users/${r.h.adminId}/settings`, data: { v: 1 } }] });
    expect(own.isError).toBe(false);
  });

  it('restore_snapshot restores data', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    await call(client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'tasks/t1', data: { v: 1 } }] });
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>2</p>' });
    await call(client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'tasks/t1', data: { v: 2 } }] });
    const snaps = await call(client, 'list_snapshots', { instance: 'todo' });
    expect(snaps.json.snapshots).toHaveLength(1);
    expect(snaps.json.snapshots[0].label).toBe('v1-to-v2');
    const res = await call(client, 'restore_snapshot', { instance: 'todo', snapshot: snaps.json.snapshots[0].id });
    expect(res.isError).toBe(false);
    const doc = await call(client, 'db_read', { instance: 'todo', path: 'tasks/t1' });
    expect(doc.json.doc.data).toEqual({ v: 1 });
    const bad = await call(client, 'restore_snapshot', { instance: 'todo', snapshot: '../../x' });
    expect(bad.isError).toBe(true);
  });

  it('tools on a foreign app are forbidden', async () => {
    const r = await start();
    const other = r.h.core.users.create({ email: 'p@x.y', name: 'P', password: 'pw2', role: 'publisher' });
    r.h.core.apps.deploy({ slug: 'theirs', html: '<p>t</p>', userId: other.id });
    r.h.core.apps.deploy({ slug: 'theirs', html: '<p>t2</p>', userId: other.id });
    const client = await connect(r);
    const attempts: [string, Record<string, unknown>][] = [
      ['deploy_app', { slug: 'theirs', html: '<p>x</p>' }],
      ['get_app', { slug: 'theirs' }],
      ['activate_version', { instance: 'theirs', version: 1 }],
      ['create_instance', { app: 'theirs', slug: 'mine-now' }],
      ['set_visibility', { instance: 'theirs', visibility: 'public' }],
      ['db_read', { instance: 'theirs', path: 'tasks' }],
      ['db_write', { instance: 'theirs', ops: [{ op: 'set', path: 'tasks/a', data: {} }] }],
      ['list_snapshots', { instance: 'theirs' }],
      ['restore_snapshot', { instance: 'theirs', snapshot: '20260101T000000000Z-x' }],
      ['share_instance', { instance: 'theirs', email: 'admin@x.y', level: 'view' }],
      ['unshare_instance', { instance: 'theirs', email: 'admin@x.y' }],
      ['list_shares', { instance: 'theirs' }],
    ];
    for (const [name, args] of attempts) {
      const res = await call(client, name, args);
      expect(res.isError, name).toBe(true);
      expect(res.json.error.code, name).toBe('forbidden');
    }
    expect((await call(client, 'list_apps')).json.apps).toEqual([]);
    expect(r.h.core.apps.getInstanceBySlug('theirs')!.activeVersion).toBe(2);
    expect(r.h.core.apps.getInstanceBySlug('mine-now')).toBeNull();
  });

  /** Creates an account and returns a client signed in as that account. */
  async function asUser(r: Running, email: string, role: 'user' | 'publisher' | 'admin' = 'user'): Promise<{ id: string; client: Client }> {
    const u = r.h.core.users.create({ email, name: email.split('@')[0], password: 'pw-' + email + '-123', role });
    return { id: u.id, client: await connect(r, r.h.core.tokens.create(u.id, 'mcp').token) };
  }

  it('share_instance, list_shares, unshare_instance', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const ada = r.h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'pw-ada-12345', role: 'user' });
    r.h.core.groups.create('team');
    const inst = (): ReturnType<typeof r.h.core.apps.getInstanceBySlug> => r.h.core.apps.getInstanceBySlug('todo');
    const levelOfAda = (): string => r.h.core.access.levelFor(inst()!, ada);

    expect((await call(client, 'list_shares', { instance: 'todo' })).json).toEqual({ grants: [], visibility: 'private', usersLevel: 'interact' });
    const shared = await call(client, 'share_instance', { instance: 'todo', email: 'ada@x.y', level: 'view' });
    expect(shared.isError).toBe(false);
    expect(shared.json.grants).toEqual([{ type: 'user', label: 'ada@x.y', level: 'view' }]);
    expect(levelOfAda()).toBe('view');
    await call(client, 'share_instance', { instance: 'todo', email: 'ada@x.y', level: 'admin' });
    expect(levelOfAda()).toBe('admin');
    const grp = await call(client, 'share_instance', { instance: 'todo', group: 'team', level: 'interact' });
    expect(grp.json.grants).toEqual([{ type: 'user', label: 'ada@x.y', level: 'admin' }, { type: 'group', label: 'team', level: 'interact' }]);
    await call(client, 'set_visibility', { instance: 'todo', visibility: 'users' });
    const listed = await call(client, 'list_shares', { instance: 'todo' });
    expect(listed.json).toMatchObject({ visibility: 'users', usersLevel: 'interact' });
    expect(listed.json.grants).toHaveLength(2);

    const unshared = await call(client, 'unshare_instance', { instance: 'todo', email: 'ada@x.y' });
    expect(unshared.json.grants).toEqual([{ type: 'group', label: 'team', level: 'interact' }]);
    // visibility 'users' still lets her in at the users level
    expect(levelOfAda()).toBe('interact');
    await call(client, 'set_visibility', { instance: 'todo', visibility: 'private' });
    expect(levelOfAda()).toBe('none');
    expect((await call(client, 'unshare_instance', { instance: 'todo', group: 'team' })).json.grants).toEqual([]);

    for (const args of [{ email: 'ada@x.y', group: 'team', level: 'view' }, { level: 'view' }]) {
      const bad = await call(client, 'share_instance', { instance: 'todo', ...args });
      expect(bad.isError, JSON.stringify(args)).toBe(true);
      expect(bad.json.error.code).toBe('invalid_argument');
    }
    // the schema only offers the grantable levels
    expect((await client.callTool({ name: 'share_instance', arguments: { instance: 'todo', email: 'ada@x.y', level: 'owner' } })).isError).toBe(true);
    expect((await call(client, 'unshare_instance', { instance: 'todo' })).json.error.code).toBe('invalid_argument');
    expect((await call(client, 'share_instance', { instance: 'todo', email: 'ghost@x.y', level: 'view' })).json.error.code).toBe('not_found');
    expect((await call(client, 'share_instance', { instance: 'todo', group: 'nogroup', level: 'view' })).json.error.code).toBe('not_found');
    expect((await call(client, 'list_shares', { instance: 'nope' })).json.error.code).toBe('not_found');
  });

  it('add_domain and remove_domain', async () => {
    const r = await start();
    const client = await connect(r);
    const port = new URL(r.base).port;
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const added = await call(client, 'add_domain', { instance: 'todo', host: 'Todo.Example.test' });
    expect(added.isError).toBe(false);
    expect(added.json).toMatchObject({ slug: 'todo', domains: [{ host: 'todo.example.test', url: `http://todo.example.test:${port}` }] });
    expect((await call(client, 'get_app', { slug: 'todo' })).json.instances[0].domains).toHaveLength(1);
    expect((await call(client, 'deploy_app', { slug: 'todo', html: '<p>2</p>' })).json.urls)
      .toEqual([`http://todo.apps.localhost:${port}`, `http://todo.example.test:${port}`]);
    expect((await call(client, 'add_domain', { instance: 'todo', host: 'todo.example.test' })).json.error.code).toBe('conflict');
    expect((await call(client, 'add_domain', { instance: 'todo', host: 'nope' })).json.error.code).toBe('invalid_argument');
    expect((await call(client, 'add_domain', { instance: 'todo', host: 'x.apps.localhost' })).json.error.code).toBe('invalid_argument');
    expect((await call(client, 'add_domain', { instance: 'nope', host: 'a.example.test' })).json.error.code).toBe('not_found');
    const removed = await call(client, 'remove_domain', { instance: 'todo', host: 'todo.example.test' });
    expect(removed.json.domains).toEqual([]);
  });

  it('a publisher is refused while the setting is admins', async () => {
    const r = await start();
    const { client } = await asUser(r, 'pub@x.y', 'publisher');
    await call(client, 'deploy_app', { slug: 'mine', html: '<p>1</p>' });
    const refused = await call(client, 'add_domain', { instance: 'mine', host: 'a.example.test' });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe('forbidden');
    r.h.core.settings.setCustomDomains('publishers');
    expect((await call(client, 'add_domain', { instance: 'mine', host: 'a.example.test' })).isError).toBe(false);
    r.h.core.settings.setCustomDomains('admins');
    expect((await call(client, 'remove_domain', { instance: 'mine', host: 'a.example.test' })).json.error.code).toBe('forbidden');
    expect(r.h.core.domains.list(r.h.core.apps.getInstanceBySlug('mine')!.id)).toEqual(['a.example.test']);
  });

  it('a platform administrator may add and remove domains of other people\'s instances', async () => {
    const r = await start();
    const { client } = await asUser(r, 'pub@x.y', 'publisher');
    await call(client, 'deploy_app', { slug: 'mine', html: '<p>1</p>' });
    const admin = await connect(r);
    expect((await call(admin, 'add_domain', { instance: 'mine', host: 'adm.example.test' })).json.domains).toHaveLength(1);
    expect((await call(admin, 'remove_domain', { instance: 'mine', host: 'adm.example.test' })).json.domains).toEqual([]);
    expect((await call(admin, 'add_domain', { instance: 'nope', host: 'adm.example.test' })).json.error.code).toBe('not_found');
    const other = await asUser(r, 'other@x.y', 'user');
    expect((await call(other.client, 'add_domain', { instance: 'mine', host: 'o.example.test' })).json.error.code).toBe('forbidden');
  });

  it('set_auto_update pins and follows', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    expect((await call(client, 'set_auto_update', { instance: 'todo', on: false })).isError).toBe(false);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>2</p>' });
    const inst = (): ReturnType<typeof r.h.core.apps.getInstanceBySlug> => r.h.core.apps.getInstanceBySlug('todo');
    expect(inst()).toMatchObject({ activeVersion: 1, autoUpdate: false });
    expect((await call(client, 'set_auto_update', { instance: 'todo', on: true })).json).toMatchObject({ slug: 'todo', activeVersion: 2 });
    expect(inst()!.autoUpdate).toBe(true);
    const other = await asUser(r, 'x@x.y');
    expect((await call(other.client, 'set_auto_update', { instance: 'todo', on: false })).json.error.code).toBe('forbidden');
  });

  it('create_instance with owner_email', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const pub = r.h.core.users.create({ email: 'pub@x.y', name: 'Pub', password: 'pw-pub-12345', role: 'publisher' });
    const made = await call(client, 'create_instance', { app: 'todo', slug: 'todo-pub', owner_email: 'pub@x.y' });
    expect(made.isError).toBe(false);
    expect(made.json.slug).toBe('todo-pub');
    expect(r.h.core.apps.getInstanceBySlug('todo-pub')!.ownerId).toBe(pub.id);
    const own = await call(client, 'create_instance', { app: 'todo', slug: 'todo-own' });
    expect(r.h.core.apps.getInstanceBySlug('todo-own')!.ownerId).toBe(r.h.adminId);
    expect(own.isError).toBe(false);
    expect((await call(client, 'create_instance', { app: 'todo', slug: 'todo-x', owner_email: 'ghost@x.y' })).json.error.code).toBe('not_found');
    expect(r.h.core.apps.getInstanceBySlug('todo-x')).toBeNull();

    // someone who may only use self-service cannot create for others
    const plain = await asUser(r, 'plain@x.y');
    r.h.core.apps.setSelfInstances(r.h.core.apps.getApp('todo')!.id, 'users', r.h.adminId);
    const other = await call(plain.client, 'create_instance', { app: 'todo', slug: 'todo-p', owner_email: 'pub@x.y' });
    expect(other.json.error.code).toBe('forbidden');
    expect(r.h.core.apps.getInstanceBySlug('todo-p')).toBeNull();
    expect((await call(plain.client, 'create_instance', { app: 'todo', slug: 'todo-p' })).isError).toBe(false);
    expect(r.h.core.apps.getInstanceBySlug('todo-p')!.ownerId).toBe(plain.id);
  });

  it('create_instance is refused for an app without self-service when the caller cannot deploy', async () => {
    const r = await start();
    await call(await connect(r), 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const plain = await asUser(r, 'plain@x.y');
    const pub = await asUser(r, 'pub@x.y', 'publisher');
    for (const who of [plain, pub]) {
      const res = await call(who.client, 'create_instance', { app: 'todo', slug: 'todo-x' });
      expect(res.isError).toBe(true);
      expect(res.json.error.code).toBe('forbidden');
    }
    expect(r.h.core.apps.getInstanceBySlug('todo-x')).toBeNull();
    // once the publisher collaborates on the app, deploying rights suffice
    r.h.core.apps.addCollaborator(r.h.core.apps.getApp('todo')!.id, pub.id, r.h.adminId);
    expect((await call(pub.client, 'create_instance', { app: 'todo', slug: 'todo-x' })).isError).toBe(false);
  });

  it('get_app is allowed for a collaborator and refused for an unrelated user', async () => {
    const r = await start();
    await call(await connect(r), 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const collab = await asUser(r, 'collab@x.y', 'publisher');
    const stranger = await asUser(r, 'stranger@x.y', 'publisher');
    r.h.core.apps.addCollaborator(r.h.core.apps.getApp('todo')!.id, collab.id, r.h.adminId);
    const ok = await call(collab.client, 'get_app', { slug: 'todo' });
    expect(ok.isError).toBe(false);
    expect(ok.json.slug).toBe('todo');
    const no = await call(stranger.client, 'get_app', { slug: 'todo' });
    expect(no.isError).toBe(true);
    expect(no.json.error.code).toBe('forbidden');
  });

  it('db_read and db_write use the caller\'s own level: a Verwalter is held to owner-only rules, the owner is not', async () => {
    const r = await start();
    const owner = await connect(r);
    const rules = [{ path: 'locked', read: 'owner', write: 'owner' }];
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>1</p>', capabilities: { db: { rules } } });
    const adm = await asUser(r, 'adm@x.y');
    await call(owner, 'share_instance', { instance: 'todo', email: 'adm@x.y', level: 'admin' });
    const inst = r.h.core.apps.getInstanceBySlug('todo')!;
    const lockedWrite = { instance: 'todo', ops: [{ op: 'set', path: 'locked/a', data: { v: 1 } }] };

    expect((await call(owner, 'db_write', lockedWrite)).json).toEqual({ applied: 1 });
    expect((await call(owner, 'db_read', { instance: 'todo', path: 'locked/a' })).json.doc.data).toEqual({ v: 1 });

    const denied = await call(adm.client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'locked/b', data: { v: 2 } }] });
    expect(denied.isError).toBe(true);
    expect(denied.json.error.code).toBe('forbidden');
    expect(r.h.core.data.get(inst.id, 'locked/b')).toBeNull();
    const read = await call(adm.client, 'db_read', { instance: 'todo', path: 'locked/a' });
    expect(read.isError).toBe(true);
    expect(read.json.error.code).toBe('forbidden');
    // Everything else stays open to the Verwalter.
    expect((await call(adm.client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'tasks/t1', data: { v: 3 } }] })).json).toEqual({ applied: 1 });
    expect((await call(adm.client, 'db_read', { instance: 'todo', path: 'tasks/t1' })).json.doc.data).toEqual({ v: 3 });
  });

  it('activate_version and db_write need an instance admin grant; interact is refused', async () => {
    const r = await start();
    const owner = await connect(r);
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>1</p>', capabilities: { db: {} } });
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>2</p>', capabilities: { db: {} } });
    const adm = await asUser(r, 'adm@x.y');
    const act = await asUser(r, 'act@x.y');
    await call(owner, 'share_instance', { instance: 'todo', email: 'adm@x.y', level: 'admin' });
    await call(owner, 'share_instance', { instance: 'todo', email: 'act@x.y', level: 'interact' });
    const inst = r.h.core.apps.getInstanceBySlug('todo')!;
    const write = { instance: 'todo', ops: [{ op: 'set', path: 'tasks/t1', data: { v: 1 } }] };

    for (const [tool, args] of [['activate_version', { instance: 'todo', version: 1 }], ['db_write', write]] as const) {
      const denied = await call(act.client, tool, args);
      expect(denied.isError, tool).toBe(true);
      expect(denied.json.error.code, tool).toBe('forbidden');
    }
    expect(r.h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(2);
    expect(r.h.core.data.get(inst.id, 'tasks/t1')).toBeNull();

    expect((await call(adm.client, 'activate_version', { instance: 'todo', version: 1 })).isError).toBe(false);
    expect(r.h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(1);
    expect((await call(adm.client, 'db_write', write)).json).toEqual({ applied: 1 });
    expect(r.h.core.data.get(inst.id, 'tasks/t1')!.data).toEqual({ v: 1 });
  });

  it('sharing tools on a foreign instance are forbidden', async () => {
    const r = await start();
    await call(await connect(r), 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const ada = await asUser(r, 'ada@x.y');
    const act = await asUser(r, 'act@x.y');
    r.h.core.access.setGrant(r.h.core.apps.getInstanceBySlug('todo')!, 'user', act.id, 'interact', r.h.core.users.get(r.h.adminId)!);
    for (const who of [ada, act]) {
      for (const [tool, args] of [
        ['share_instance', { instance: 'todo', email: 'ada@x.y', level: 'admin' }],
        ['unshare_instance', { instance: 'todo', email: 'act@x.y' }],
        ['list_shares', { instance: 'todo' }],
      ] as const) {
        const res = await call(who.client, tool, args);
        expect(res.isError, tool).toBe(true);
        expect(res.json.error.code, tool).toBe('forbidden');
      }
    }
    expect(r.h.core.access.listGrants(r.h.core.apps.getInstanceBySlug('todo')!.id)).toHaveLength(1);
  });

  it('db_write reports how many operations were applied when one fails midway', async () => {
    // A quota of one byte: the first write creates the database, every later one is refused.
    const r = await start(1);
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>', capabilities: { db: {} } });
    const inst = r.h.core.apps.getInstanceBySlug('todo')!;
    const res = await call(client, 'db_write', {
      instance: 'todo',
      ops: [
        { op: 'set', path: 'tasks/t1', data: { n: 1 } },
        { op: 'set', path: 'tasks/t2', data: { n: 2 } },
        { op: 'set', path: 'tasks/t3', data: { n: 3 } },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe('quota_exceeded');
    expect(res.json.error.message).toContain('1 of 3 operations were applied before the error');
    expect(r.h.core.data.get(inst.id, 'tasks/t1')!.data).toEqual({ n: 1 });
    expect(r.h.core.data.get(inst.id, 'tasks/t2')).toBeNull();
  });

  it('import_data then export_data with prefix and truncation', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const docs = [
      ...Array.from({ length: 5 }, (_, i) => ({ path: `tasks/t${i}`, data: { n: i } })),
      { path: 'tasks/t0/notes/n1', data: { sub: true } }, { path: 'tasksx/y', data: { other: true } }, { path: 'settings/main', data: { theme: 'x' } },
    ];
    const imp = await call(client, 'import_data', { instance: 'todo', docs });
    expect(imp.json).toEqual({ imported: 8 });
    const all = await call(client, 'export_data', { instance: 'todo' });
    expect(all.json.truncated).toBe(false);
    expect(all.json.docs.map((d: { path: string }) => d.path)).toEqual(
      ['settings/main', 'tasks/t0', 'tasks/t0/notes/n1', 'tasks/t1', 'tasks/t2', 'tasks/t3', 'tasks/t4', 'tasksx/y']);
    const pre = await call(client, 'export_data', { instance: 'todo', prefix: 'tasks' });
    expect(pre.json.docs.map((d: { path: string }) => d.path)).toEqual(['tasks/t0', 'tasks/t0/notes/n1', 'tasks/t1', 'tasks/t2', 'tasks/t3', 'tasks/t4']);
    expect(pre.json.docs[0]).toEqual({ path: 'tasks/t0', data: { n: 0 } });
    const cut = await call(client, 'export_data', { instance: 'todo', prefix: 'tasks/', limit: 2 });
    expect(cut.json.docs).toHaveLength(2);
    expect(cut.json.truncated).toBe(true);
    const exact = await call(client, 'export_data', { instance: 'todo', prefix: 'tasks', limit: 6 });
    expect(exact.json.truncated).toBe(false);
    expect((await client.callTool({ name: 'export_data', arguments: { instance: 'todo', limit: 1001 } })).isError).toBe(true);
    expect((await client.callTool({ name: 'import_data', arguments: { instance: 'todo', docs: Array.from({ length: 1001 }, (_, i) => ({ path: `x/${i}`, data: {} })) } })).isError).toBe(true);
    expect((await client.callTool({ name: 'import_data', arguments: { instance: 'todo', docs: [] } })).isError).toBe(true);
    const bad = await call(client, 'import_data', { instance: 'todo', docs: [{ path: 'ok/1', data: {} }, { path: 'a//b', data: {} }] });
    expect(bad.json.error.code).toBe('invalid_argument');
    expect(r.h.core.data.get(r.h.core.apps.getInstanceBySlug('todo')!.id, 'ok/1')).toBeNull();
  });

  it('import_data and export_data keep other users private areas closed', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    const inst = r.h.core.apps.getInstanceBySlug('todo')!;
    r.h.core.data.set(inst.id, 'data/users/someone/storage/kv/s', { secret: 1 }, 'someone');
    r.h.core.data.set(inst.id, `data/users/${r.h.adminId}/storage/kv/mine`, { mine: 1 }, null);
    const exp = await call(client, 'export_data', { instance: 'todo' });
    expect(exp.json.docs.map((d: { path: string }) => d.path)).toEqual([`data/users/${r.h.adminId}/storage/kv/mine`]);
    for (const prefix of ['data/users/someone', 'data/users', 'data']) {
      const e = await call(client, 'export_data', { instance: 'todo', prefix });
      expect(e.json.docs.map((d: { path: string }) => d.path)).not.toContain('data/users/someone/storage/kv/s');
    }
    for (const path of ['data/users/someone/storage/kv/s', 'DATA/users/someone/storage/kv/s', 'data/users']) {
      const w = await call(client, 'import_data', { instance: 'todo', docs: [{ path: 'ok/1', data: {} }, { path, data: { hacked: 1 } }] });
      expect(w.isError).toBe(true);
      expect(w.json.error.code).toBe('forbidden');
    }
    expect(r.h.core.data.get(inst.id, 'ok/1')).toBeNull();
    expect(r.h.core.data.get(inst.id, 'data/users/someone/storage/kv/s')!.data).toEqual({ secret: 1 });
    const own = await call(client, 'import_data', { instance: 'todo', docs: [{ path: `data/users/${r.h.adminId}/storage/kv/mine`, data: { mine: 2 } }] });
    expect(own.json).toEqual({ imported: 1 });
  });

  it('import_data and export_data hold a Verwalter to the app rules and refuse interact', async () => {
    const r = await start();
    const owner = await connect(r);
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>1</p>', capabilities: { db: { rules: [{ path: 'locked', read: 'owner', write: 'owner' }] } } });
    await call(owner, 'import_data', { instance: 'todo', docs: [{ path: 'locked/a', data: { v: 1 } }, { path: 'open/a', data: { v: 2 } }] });
    const adm = await asUser(r, 'adm@x.y');
    const act = await asUser(r, 'act@x.y');
    await call(owner, 'share_instance', { instance: 'todo', email: 'adm@x.y', level: 'admin' });
    await call(owner, 'share_instance', { instance: 'todo', email: 'act@x.y', level: 'interact' });
    const seen = await call(adm.client, 'export_data', { instance: 'todo' });
    expect(seen.json.docs.map((d: { path: string }) => d.path)).toEqual(['open/a']);
    const w = await call(adm.client, 'import_data', { instance: 'todo', docs: [{ path: 'locked/b', data: {} }] });
    expect(w.json.error.code).toBe('forbidden');
    expect((await call(adm.client, 'import_data', { instance: 'todo', docs: [{ path: 'open/b', data: {} }] })).json).toEqual({ imported: 1 });
    expect((await call(act.client, 'export_data', { instance: 'todo' })).json.error.code).toBe('forbidden');
    expect((await call(act.client, 'import_data', { instance: 'todo', docs: [{ path: 'open/c', data: {} }] })).json.error.code).toBe('forbidden');
  });

  it('check_artifact', async () => {
    const r = await start();
    const client = await connect(r);
    const res = await call(client, 'check_artifact', { html: '<script>claude.use("db"); claude.use("tts"); claude.complete("x")</script>', capabilities: {} });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ used: ['db', 'tts'], unsupported: ['tts'], undeclared: ['db'] });
    expect(res.json.warnings).toHaveLength(3);
    expect((await call(client, 'check_artifact', { html: '<p>x</p>' })).json).toEqual({ used: [], unsupported: [], undeclared: [], warnings: [] });
    const plain = await asUser(r, 'plain@x.y');
    expect((await call(plain.client, 'check_artifact', { html: '<p>x</p>' })).json.error.code).toBe('forbidden');
  });

  it('no bearer → 401 with WWW-Authenticate resource_metadata', async () => {
    const r = await start();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const auth of [undefined, 'Bearer lgr_wrong', 'Bearer wrong']) {
      const res = await fetch(`${r.base}/mcp`, { method: 'POST', body, headers: auth ? { ...headers, Authorization: auth } : headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${r.base}/.well-known/oauth-protected-resource"`);
    }
    const get = await fetch(`${r.base}/mcp`, { headers: { Authorization: `Bearer ${r.token}` } });
    expect(get.status).toBe(405);
    const del = await fetch(`${r.base}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${r.token}` } });
    expect(del.status).toBe(405);
  });

  it('the SDK client completes OAuth discovery, consent and token exchange on its own', async () => {
    const r = await start();
    const login = await fetch(`${r.base}/login`, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'admin@x.y', password: 'pw' }),
    });
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lager_session='))!.split(';')[0];
    let code = '';
    let info: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier = '';
    const provider: OAuthClientProvider = {
      get redirectUrl() { return 'http://localhost:9999/callback'; },
      get clientMetadata() {
        return { redirect_uris: ['http://localhost:9999/callback'], client_name: 'SDK test', token_endpoint_auth_method: 'none' };
      },
      clientInformation: () => info,
      saveClientInformation: (i) => { info = i; },
      tokens: () => tokens,
      saveTokens: (t) => { tokens = t; },
      saveCodeVerifier: (v) => { verifier = v; },
      codeVerifier: () => verifier,
      async redirectToAuthorization(url) {
        // play the browser: consent page, then approve
        const page = await (await fetch(url, { headers: { Cookie: cookie } })).text();
        const fields: Record<string, string> = {};
        for (const m of page.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
          fields[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        }
        const approve = await fetch(`${r.base}/authorize`, {
          method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body: new URLSearchParams({ ...fields, decision: 'approve' }),
        });
        code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
      },
    };
    const first = new StreamableHTTPClientTransport(new URL(`${r.base}/mcp`), { authProvider: provider });
    await expect(new Client({ name: 't', version: '1' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(code).not.toBe('');
    await first.finishAuth(code);
    expect(tokens?.access_token).toBeTruthy();

    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${r.base}/mcp`), { authProvider: provider }));
    clients.push(client);
    expect((await client.listTools()).tools).toHaveLength(21);
  });

  describe('icons and descriptions', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#336699"/><circle cx="256" cy="256" r="100" fill="#fff"/></svg>';
    const NO_ICON = 'No icon supplied; a generated one is used. Pass icon_svg to set your own.';
    const png = async (url: string): Promise<{ status: number; w: number; type: string | null }> => {
      const res = await fetch(url);
      const b = Buffer.from(await res.arrayBuffer());
      return { status: res.status, w: b.length > 24 ? b.readUInt32BE(16) : 0, type: res.headers.get('content-type') };
    };

    it('deploy_app with icon_svg, description and theme_color', async () => {
      const r = await start();
      const client = await connect(r);
      const dep = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', title: 'Todo', icon_svg: SVG, description: '  A shared list.  ', theme_color: '#369' });
      expect(dep.isError).toBe(false);
      expect(dep.json.warnings).toEqual([]);
      expect(dep.json).toMatchObject({ description: 'A shared list.', themeColor: '#336699' });
      const got = await call(client, 'get_app', { slug: 'todo' });
      expect(got.json).toMatchObject({ description: 'A shared list.', themeColor: '#336699' });
      const app = r.h.core.apps.getApp('todo')!;
      expect(got.json.iconUrl).toBe(`${r.base}/app-icons/${app.id}/${app.iconVersion}/192.png`);
      expect(await png(got.json.iconUrl)).toEqual({ status: 200, w: 192, type: 'image/png' });
      expect(dep.json.iconUrl).toBe(got.json.iconUrl);
      const list = await call(client, 'list_apps');
      expect(list.json.apps[0]).toMatchObject({ description: 'A shared list.', themeColor: '#336699', iconUrl: got.json.iconUrl });
    });

    it('first deploy without an icon gets the default and a warning', async () => {
      const r = await start();
      const client = await connect(r);
      const dep = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>' });
      expect(dep.json.warnings).toEqual([NO_ICON]);
      expect(dep.json).toMatchObject({ description: '', themeColor: '#1f2a5c' });
      expect(await png(dep.json.iconUrl)).toMatchObject({ status: 200, w: 192 });
    });

    it('redeploy without icon_svg keeps the icon, description and colour', async () => {
      const r = await start();
      const client = await connect(r);
      await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', icon_svg: SVG, description: 'Keep me', theme_color: '#336699' });
      const before = r.h.core.apps.getApp('todo')!;
      const bytes = fs.readFileSync(r.h.core.icons.png(before.id, 512)!);
      const dep = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t2</p>' });
      expect(dep.json.warnings).toEqual([]);
      const after = r.h.core.apps.getApp('todo')!;
      expect(after).toMatchObject({ iconVersion: before.iconVersion, description: 'Keep me', themeColor: '#336699' });
      expect(fs.readFileSync(r.h.core.icons.png(after.id, 512)!).equals(bytes)).toBe(true);
    });

    it('redeploy with a new icon bumps the icon version', async () => {
      const r = await start();
      const client = await connect(r);
      await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>' });
      const v1 = r.h.core.apps.getApp('todo')!.iconVersion;
      const dep = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', icon_svg: SVG });
      expect(dep.json.warnings).toEqual([]);
      expect(r.h.core.apps.getApp('todo')!.iconVersion).toBeGreaterThan(v1);
    });

    it('a new theme colour redraws the maskable variant', async () => {
      const r = await start();
      const client = await connect(r);
      await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', icon_svg: SVG, theme_color: '#336699' });
      const app = r.h.core.apps.getApp('todo')!;
      const before = fs.readFileSync(r.h.core.icons.png(app.id, 512, true)!);
      await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', theme_color: '#993366' });
      expect(r.h.core.apps.getApp('todo')!.iconVersion).toBeGreaterThan(app.iconVersion);
      expect(fs.readFileSync(r.h.core.icons.png(app.id, 512, true)!).equals(before)).toBe(false);
    });

    it('an invalid icon does not fail the deploy but is reported', async () => {
      const r = await start();
      const client = await connect(r);
      const first = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', icon_svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' });
      expect(first.isError).toBe(false);
      expect(first.json.version).toBe(1);
      expect(first.json.warnings).toHaveLength(1);
      expect(first.json.warnings[0]).toMatch(/icon/i);
      expect(first.json.warnings[0]).toMatch(/<script>/);
      expect(first.json.warnings[0]).not.toBe(NO_ICON);
      const app = r.h.core.apps.getApp('todo')!;
      expect(r.h.core.icons.has(app.id)).toBe(true);
      expect(await png(first.json.iconUrl)).toMatchObject({ status: 200 });
      // On a redeploy the previous icon stays.
      await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', icon_svg: SVG });
      const good = r.h.core.apps.getApp('todo')!;
      const bytes = fs.readFileSync(r.h.core.icons.png(good.id, 512)!);
      const again = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t2</p>', icon_svg: 'not svg' });
      expect(again.isError).toBe(false);
      expect(again.json.warnings).toHaveLength(1);
      expect(r.h.core.apps.getApp('todo')!.iconVersion).toBe(good.iconVersion);
      expect(fs.readFileSync(r.h.core.icons.png(good.id, 512)!).equals(bytes)).toBe(true);
    });

    it('an invalid description or colour fails the deploy', async () => {
      const r = await start();
      const client = await connect(r);
      const long = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', description: 'x'.repeat(201) });
      expect(long.isError).toBe(true);
      expect(long.json.error.code).toBe('invalid_argument');
      const color = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', theme_color: 'blue' });
      expect(color.isError).toBe(true);
      expect(r.h.core.apps.getApp('todo')).toBeNull();
    });

    it('set_app_icon: owner yes, stranger no, invalid icon is an error', async () => {
      const r = await start();
      const client = await connect(r);
      await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>' });
      const v1 = r.h.core.apps.getApp('todo')!.iconVersion;
      const ok = await call(client, 'set_app_icon', { app: 'todo', icon_svg: SVG, description: 'Now with a picture', theme_color: '#abc' });
      expect(ok.isError).toBe(false);
      expect(ok.json).toMatchObject({ slug: 'todo', description: 'Now with a picture', themeColor: '#aabbcc' });
      expect(r.h.core.apps.getApp('todo')!.iconVersion).toBeGreaterThan(v1);
      expect(await png(ok.json.iconUrl)).toMatchObject({ status: 200, w: 192 });

      const before = r.h.core.apps.getApp('todo')!;
      const bad = await call(client, 'set_app_icon', { app: 'todo', icon_svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://x.y/a.png"/></svg>', description: 'changed anyway?' });
      expect(bad.isError).toBe(true);
      expect(bad.json.error.code).toBe('invalid_argument');
      expect(r.h.core.apps.getApp('todo')).toEqual(before);

      const none = await call(client, 'set_app_icon', { app: 'todo' });
      expect(none.isError).toBe(true);
      expect(none.json.error.code).toBe('invalid_argument');

      const descOnly = await call(client, 'set_app_icon', { app: 'todo', description: 'Only words' });
      expect(descOnly.isError).toBe(false);
      expect(r.h.core.apps.getApp('todo')).toMatchObject({ description: 'Only words', iconVersion: before.iconVersion });

      const missing = await call(client, 'set_app_icon', { app: 'nope', description: 'x' });
      expect(missing.json.error.code).toBe('not_found');

      const stranger = r.h.core.users.create({ email: 'p@x.y', name: 'P', password: 'pw-p-12345', role: 'publisher' });
      const other = await connect(r, r.h.core.tokens.create(stranger.id, 'mcp').token);
      const denied = await call(other, 'set_app_icon', { app: 'todo', icon_svg: SVG });
      expect(denied.isError).toBe(true);
      expect(denied.json.error.code).toBe('forbidden');
      expect(r.h.core.apps.getApp('todo')).toMatchObject({ description: 'Only words', iconVersion: before.iconVersion });

      // A collaborator may.
      r.h.core.apps.addCollaborator(before.id, stranger.id, r.h.adminId);
      expect((await call(other, 'set_app_icon', { app: 'todo', description: 'By a collaborator' })).isError).toBe(false);
    });

    it('deleting the app removes its icon files', async () => {
      const r = await start();
      const client = await connect(r);
      await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', icon_svg: SVG });
      const app = r.h.core.apps.getApp('todo')!;
      expect(r.h.core.icons.has(app.id)).toBe(true);
      r.h.core.apps.deleteApp(app.id, r.h.adminId);
      expect(r.h.core.icons.has(app.id)).toBe(false);
    });
  });
});

