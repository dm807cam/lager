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

async function start(): Promise<Running> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const h = makeHarness({ publicUrl: `http://127.0.0.1:${port}`, extensions: [apiExtension, mcpExtension] });
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
  it('lists the eleven tools and exposes instructions', async () => {
    const r = await start();
    const client = await connect(r);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'activate_version', 'create_instance', 'db_read', 'db_write', 'deploy_app', 'get_app', 'get_guide',
      'list_apps', 'list_snapshots', 'restore_snapshot', 'set_visibility',
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
    expect(dep.json).toEqual({ app: 'todo', version: 1, createdVersion: true, urls: [`http://todo.apps.localhost:${new URL(r.base).port}`], warnings: [] });
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
    expect(dep.json.warnings).toHaveLength(1);
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
    expect((await client.listTools()).tools).toHaveLength(11);
  });
});
