import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { DEPLOYS_PER_HOUR } from '../src/core.js';
import { apiExtension } from '../src/http/api.js';
import { mcpExtension } from '../src/mcp/http.js';
import { editVersion, MIN_PART_BYTES } from '../src/mcp/tools.js';
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
  it('lists the twenty-five tools and exposes instructions', async () => {
    const r = await start();
    const client = await connect(r);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'activate_version', 'add_domain', 'check_app', 'create_instance', 'db_read', 'db_write', 'deploy_app', 'edit_version', 'export_data', 'get_app', 'get_guide', 'get_version',
      'import_data', 'list_apps', 'list_models', 'list_shares', 'list_snapshots', 'remove_domain', 'restore_snapshot', 'set_app_icon', 'set_app_model', 'set_auto_update', 'set_visibility',
      'share_instance', 'unshare_instance',
    ]);
    expect(client.getServerVersion()?.name).toBe('lager');
    const firstSection = guide.split(/\r?\n---\r?\n/)[0].trim();
    expect(client.getInstructions()?.trim()).toBe(firstSection);
    expect(firstSection.split('\n').length).toBeLessThanOrEqual(15);
    const g = await call(client, 'get_guide');
    expect(g.json.guide).toBe(guide);
  });

  it('every tool the guide names exists', async () => {
    const r = await start();
    const client = await connect(r);
    const registered = new Set((await client.listTools()).tools.map((t) => t.name));
    const TOOL_LIKE = /`((?:activate|add|check|create|db|deploy|edit|export|get|import|list|remove|restore|set|share|unshare)_[a-z_]+)\b/g;
    const named = [...new Set([...guide.matchAll(TOOL_LIKE)].map((m) => m[1]))];
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(registered.has(name), `guide names ${name}`).toBe(true);
  });

  it('tools carry titles and annotations, and schemas that other MCP clients accept', async () => {
    const r = await start();
    const client = await connect(r);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
      // `propertyNames` (what z.record emits) is refused by some clients and model providers.
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('propertyNames');
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(['check_app', 'export_data', 'get_app', 'get_guide', 'get_version', 'list_apps', 'list_models', 'list_shares', 'list_snapshots', 'db_read'].sort());
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort();
    expect(destructive).toEqual(['db_write', 'import_data', 'remove_domain', 'restore_snapshot', 'set_visibility', 'share_instance', 'unshare_instance']);
    const deploy = tools.find((t) => t.name === 'deploy_app')!;
    const caps = (deploy.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>).capabilities;
    expect(Object.keys(caps.properties ?? {})).toEqual(['db', 'user', 'assets', 'room', 'page', 'downloads', 'complete', 'ingest', 'embed']);
    expect(deploy.description).toContain('get_guide');
  });

  it('deploy_app keeps capability names the schema does not list, and warns about them', async () => {
    const r = await start();
    const client = await connect(r);
    const res = await call(client, 'deploy_app', { slug: 'selfie', html: '<!doctype html><p>hi</p>', capabilities: { future: {}, db: { rules: [] } } });
    expect(res.isError).toBe(false);
    expect(res.json.warnings).toContain('"future" is declared in capabilities, but Lager has no such capability.');
    const version = await client.callTool({ name: 'get_version', arguments: { app: 'selfie' } });
    const meta = JSON.parse((version.content as Array<{ text: string }>)[0].text);
    expect(Object.keys(meta.capabilities).sort()).toEqual(['db', 'future']);
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

  /** Calls get_version and returns its JSON block and its raw HTML block. */
  async function getVersion(client: Client, args: Record<string, unknown>): Promise<{ meta: any; html: string }> {
    const res = await client.callTool({ name: 'get_version', arguments: args });
    expect(res.isError).not.toBe(true);
    const content = res.content as { type: string; text: string }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'text']);
    return { meta: JSON.parse(content[0].text), html: content[1].text };
  }

  it('get_version returns the source so a later session can continue the app', async () => {
    const r = await start();
    const client = await connect(r);
    const v1 = '<!doctype html>\n<p class="a">"one"</p>';
    const v2 = '<!doctype html>\n<script>const db = await lager.use("db");</script>';
    await call(client, 'deploy_app', { slug: 'todo', html: v1, title: 'Todo', note: 'first' });
    await call(client, 'deploy_app', { slug: 'todo', html: v2, capabilities: { db: { rules: [{ path: 'tasks', write: 'admin' }] }, user: {} }, note: 'second' });

    const latest = await getVersion(client, { app: 'todo' });
    expect(latest.html).toBe(v2);
    expect(latest.meta).toMatchObject({
      app: 'todo', title: 'Todo', version: 2, note: 'second', savedByInstance: null,
      capabilities: { db: { rules: [{ path: 'tasks', write: 'admin' }] }, user: {} },
    });
    expect(latest.meta.sizeBytes).toBe(Buffer.byteLength(v2));

    const first = await getVersion(client, { app: 'todo', version: 1 });
    expect(first.html).toBe(v1);
    expect(first.meta).toMatchObject({ version: 1, note: 'first', capabilities: {} });

    await call(client, 'activate_version', { instance: 'todo', version: 1 });
    expect((await getVersion(client, { instance: 'todo' })).html).toBe(v1);

    // Redeploying what came back with the same capabilities is a no-op.
    const again = await call(client, 'deploy_app', { slug: 'todo', html: latest.html, capabilities: latest.meta.capabilities });
    expect(again.json).toMatchObject({ version: 2, createdVersion: false });

    for (const [args, code] of [
      [{ app: 'todo', version: 9 }, 'not_found'],
      [{ app: 'nope' }, 'not_found'],
      [{ instance: 'nope' }, 'not_found'],
      [{}, 'invalid_argument'],
      [{ app: 'todo', instance: 'todo' }, 'invalid_argument'],
      [{ instance: 'todo', version: 1 }, 'invalid_argument'],
    ] as const) {
      const res = await call(client, 'get_version', args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(res.json.error.code, JSON.stringify(args)).toBe(code);
    }
  });

  it('get_version reads a large app in parts that join to the whole HTML', async () => {
    const r = await start();
    const client = await connect(r);
    // Multi-byte characters straddle the part borders, so a part that split one would corrupt the joined source.
    const html = `<!doctype html>\n${'<p>Grüße 🌿 – naïve</p>\n'.repeat(400)}`;
    await call(client, 'deploy_app', { slug: 'big', html, capabilities: { db: {} } });
    const total = Buffer.byteLength(html);

    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const part = await getVersion(client, { app: 'big', offset, limit: 1500 });
      expect(part.meta).toMatchObject({ app: 'big', version: 1, sizeBytes: total, offset, capabilities: { db: {} } });
      expect(Buffer.byteLength(part.html)).toBeLessThanOrEqual(1500);
      expect(part.html).not.toContain('\uFFFD');
      parts.push(part.html);
      offset = part.meta.nextOffset;
    }
    expect(parts.length).toBeGreaterThanOrEqual(Math.ceil(total / 1500));
    expect(crypto.createHash('sha256').update(parts.join('')).digest('hex')).toBe((await getVersion(client, { app: 'big' })).meta.sha256);
    expect(parts.join('')).toBe(html);

    // Without a range, or with a limit beyond the size, the whole HTML comes back and says it is complete.
    expect((await getVersion(client, { app: 'big' })).meta).toMatchObject({ offset: 0, nextOffset: null });
    const whole = await getVersion(client, { app: 'big', limit: total + 1 });
    expect(whole.html).toBe(html);
    expect(whole.meta.nextOffset).toBeNull();
    // A tiny limit is raised to the floor, so reading in parts never takes thousands of calls.
    const floored = await getVersion(client, { instance: 'big', limit: 10 });
    expect(floored.meta.nextOffset).toBeGreaterThan(MIN_PART_BYTES - 4);
    expect(Buffer.byteLength(floored.html)).toBeLessThanOrEqual(MIN_PART_BYTES);
    expect(html.startsWith(floored.html)).toBe(true);
    // Reading from the very end gives an empty part that says it is the last one.
    const end = await getVersion(client, { app: 'big', offset: total, limit: 5000 });
    expect(end.html).toBe('');
    expect(end.meta).toMatchObject({ offset: total, nextOffset: null });

    const inside = Buffer.from(html).indexOf(Buffer.from('ü')) + 1;
    for (const args of [{ app: 'big', offset: total + 1 }, { app: 'big', offset: inside }]) {
      const res = await call(client, 'get_version', args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(res.json.error.code, JSON.stringify(args)).toBe('invalid_argument');
    }
  });

  it('get_version: parts read with the version of the first part join to that version, even after a deploy', async () => {
    const r = await start();
    const client = await connect(r);
    const v1 = `<!doctype html>\n${'<p>first</p>\n'.repeat(300)}`;
    await call(client, 'deploy_app', { slug: 'big', html: v1 });
    const first = await getVersion(client, { app: 'big', limit: 2000 });
    expect(first.meta.version).toBe(1);

    // Someone deploys in the middle of the read; the next parts name the version from the first answer.
    await call(client, 'deploy_app', { slug: 'big', html: `<!doctype html>\n${'<p>second, longer</p>\n'.repeat(300)}` });
    const parts = [first.html];
    let offset: number | null = first.meta.nextOffset;
    while (offset !== null) {
      const part = await getVersion(client, { app: 'big', version: first.meta.version, offset, limit: 2000 });
      expect(part.meta.version).toBe(1);
      parts.push(part.html);
      offset = part.meta.nextOffset;
    }
    expect(parts.join('')).toBe(v1);
    expect(crypto.createHash('sha256').update(parts.join('')).digest('hex')).toBe(first.meta.sha256);
  });

  it('get_version: collaborators read the code, people the instance is only shared with do not', async () => {
    const r = await start();
    const owner = await connect(r);
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>secret code</p>' });
    const collab = await asUser(r, 'collab@x.y', 'publisher');
    const viewer = await asUser(r, 'viewer@x.y');
    r.h.core.apps.addCollaborator(r.h.core.apps.getApp('todo')!.id, collab.id, r.h.adminId);
    await call(owner, 'share_instance', { instance: 'todo', email: 'viewer@x.y', level: 'interact' });

    expect((await getVersion(collab.client, { app: 'todo' })).html).toBe('<p>secret code</p>');
    await call(owner, 'create_instance', { app: 'todo', slug: 'portal' });
    await call(owner, 'share_instance', { instance: 'portal', email: 'viewer@x.y', level: 'admin' });
    const viaInstance = await call(viewer.client, 'get_version', { instance: 'portal' });
    expect(viaInstance.json.error.code).toBe('forbidden');
    expect(viaInstance.json.error.message).not.toContain('todo');
    // Reading in parts is refused just like reading whole: `call` also checks that no HTML block comes back.
    const stranger = await asUser(r, 'stranger@x.y', 'publisher');
    for (const client of [viewer.client, stranger.client]) {
      for (const args of [{ app: 'todo' }, { instance: 'todo' }, { instance: 'todo', limit: 10 }, { app: 'todo', offset: 0, limit: 10 }, { app: 'todo', version: 1, offset: 3, limit: 2000 }]) {
        const res = await call(client, 'get_version', args);
        expect(res.isError, JSON.stringify(args)).toBe(true);
        expect(res.json.error.code, JSON.stringify(args)).toBe('forbidden');
      }
    }
    const partOfPortal = await call(stranger.client, 'get_version', { instance: 'portal', offset: 0, limit: 10 });
    expect(partOfPortal.json.error.code).toBe('forbidden');
  });

  it('get_version by instance returns a page the instance saved itself, to its managers only', async () => {
    const r = await start();
    const owner = await connect(r);
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>deployed</p>', capabilities: { page: {} } });
    const inst = r.h.core.apps.getInstanceBySlug('todo')!;
    const saved = '<!doctype html><p>saved by the page</p>';
    r.h.core.apps.selfPublish({ instanceId: inst.id, html: saved, baseVersion: 1, userId: r.h.adminId });

    const got = await getVersion(owner, { instance: 'todo' });
    expect(got.html).toBe(saved);
    expect(got.meta).toMatchObject({ version: 2, savedByInstance: 'todo', capabilities: { page: {} } });
    // By app, the latest deployed version is still the deployed one.
    expect((await getVersion(owner, { app: 'todo' })).html).toBe('<p>deployed</p>');

    const collab = await asUser(r, 'collab@x.y', 'publisher');
    r.h.core.apps.addCollaborator(inst.appId, collab.id, r.h.adminId);
    const res = await call(collab.client, 'get_version', { app: 'todo', version: 2 });
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe('forbidden');
  });

  it('edit_version changes the latest version without resending its HTML', async () => {
    const r = await start();
    const client = await connect(r);
    const v1 = '<!doctype html>\n<style>.a { color: red; }</style>\n<p class="a">one</p>\n<p>$&</p>\n';
    const caps = { db: { rules: [{ path: 'tasks', write: 'admin' }] }, user: {} };
    await call(client, 'deploy_app', { slug: 'todo', html: v1, capabilities: caps, title: 'Todo' });

    const edited = await call(client, 'edit_version', {
      slug: 'todo', base_version: 1, note: 'blue',
      // In order: the second edit matches text the first one wrote. `$&` is taken literally, not as a replacement pattern.
      edits: [{ old_text: 'color: red;', new_text: 'color: blue;' }, { old_text: 'blue; }', new_text: 'blue; font-weight: bold; }' }, { old_text: '<p>$&</p>\n', new_text: '' }],
    });
    expect(edited.isError).toBe(false);
    expect(edited.json).toMatchObject({ app: 'todo', version: 2, createdVersion: true });
    const v2 = await getVersion(client, { app: 'todo' });
    expect(v2.html).toBe('<!doctype html>\n<style>.a { color: blue; font-weight: bold; }</style>\n<p class="a">one</p>\n');
    // Capabilities and title are kept, the note is the new one.
    expect(v2.meta).toMatchObject({ version: 2, title: 'Todo', note: 'blue', capabilities: caps });

    // New capabilities replace the old ones when given.
    const withCaps = await call(client, 'edit_version', { slug: 'todo', base_version: 2, edits: [{ old_text: 'one', new_text: 'two' }], capabilities: { db: {} } });
    expect(withCaps.json).toMatchObject({ version: 3, createdVersion: true });
    expect((await getVersion(client, { app: 'todo' })).meta.capabilities).toEqual({ db: {} });

    const refusals: Array<[Record<string, unknown>, string, string?]> = [
      // Written against an older version: someone deployed since.
      [{ slug: 'todo', base_version: 2, edits: [{ old_text: 'two', new_text: 'three' }] }, 'conflict', 'version 3'],
      [{ slug: 'todo', base_version: 9, edits: [{ old_text: 'two', new_text: 'three' }] }, 'conflict'],
      [{ slug: 'todo', base_version: 3, edits: [{ old_text: 'nowhere', new_text: 'x' }] }, 'invalid_argument', 'not found'],
      [{ slug: 'todo', base_version: 3, edits: [{ old_text: '\n', new_text: 'x' }] }, 'invalid_argument', 'more than once'],
      // Overlapping matches are ambiguous too.
      [{ slug: 'todo', base_version: 3, edits: [{ old_text: 'two', new_text: 'aaa' }, { old_text: 'aa', new_text: 'b' }] }, 'invalid_argument', 'Edit 2'],
      [{ slug: 'todo', base_version: 3, edits: [{ old_text: 'two', new_text: 'x' }, { old_text: 'two', new_text: 'y' }] }, 'invalid_argument', 'earlier edits'],
      [{ slug: 'todo', base_version: 3, edits: [{ old_text: '', new_text: 'x' }] }, 'invalid_argument', 'empty'],
      [{ slug: 'nope', base_version: 1, edits: [{ old_text: 'a', new_text: 'b' }] }, 'not_found'],
    ];
    for (const [args, code, message] of refusals) {
      const res = await call(client, 'edit_version', args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(res.json.error.code, JSON.stringify(args)).toBe(code);
      if (message) expect(res.json.error.message, JSON.stringify(args)).toContain(message);
    }
    // A failed edit deploys nothing, not even the edits before it.
    expect(r.h.core.apps.latestDeployedVersion(r.h.core.apps.getApp('todo')!.id)?.number).toBe(3);
    const noEdits = await client.callTool({ name: 'edit_version', arguments: { slug: 'todo', base_version: 3, edits: [] } });
    expect(noEdits.isError).toBe(true);

    // Edits that change nothing make no new version.
    const same = await call(client, 'edit_version', { slug: 'todo', base_version: 3, edits: [{ old_text: 'two', new_text: 'two' }] });
    expect(same.json).toMatchObject({ version: 3, createdVersion: false });
  });

  it('edit_version: only those who deploy the app may edit it, and a page saved by an instance is not a base', async () => {
    const r = await start();
    const owner = await connect(r);
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>secret code</p>', capabilities: { page: {} } });
    const edit = { slug: 'todo', base_version: 1, edits: [{ old_text: 'secret', new_text: 'open' }] };

    const stranger = await asUser(r, 'stranger@x.y', 'publisher');
    const viewer = await asUser(r, 'viewer@x.y');
    await call(owner, 'share_instance', { instance: 'todo', email: 'viewer@x.y', level: 'admin' });
    for (const client of [stranger.client, viewer.client]) {
      const res = await call(client, 'edit_version', edit);
      expect(res.isError).toBe(true);
      expect(res.json.error.code).toBe('forbidden');
      // A refusal must not tell whether the text would have matched.
      expect(res.json.error.message).not.toContain('secret');
    }
    const collab = await asUser(r, 'collab@x.y', 'publisher');
    r.h.core.apps.addCollaborator(r.h.core.apps.getApp('todo')!.id, collab.id, r.h.adminId);

    const inst = r.h.core.apps.getInstanceBySlug('todo')!;
    r.h.core.apps.selfPublish({ instanceId: inst.id, html: '<p>saved secret</p>', baseVersion: 1, userId: r.h.adminId });
    const onSaved = await call(collab.client, 'edit_version', { ...edit, base_version: 2 });
    expect(onSaved.json.error.code).toBe('conflict');

    const ok = await call(collab.client, 'edit_version', edit);
    expect(ok.isError).toBe(false);
    expect((await getVersion(owner, { app: 'todo' })).html).toBe('<p>open code</p>');
  });

  it('edit_version refuses platform admins, removed collaborators, disabled accounts and apps over the deploy limit', async () => {
    const r = await start();
    const owner = await connect(r);
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>secret code</p>' });
    const appId = r.h.core.apps.getApp('todo')!.id;
    const edit = { slug: 'todo', base_version: 1, edits: [{ old_text: 'secret', new_text: 'open' }] };
    const expectForbidden = (res: { isError: boolean; json: any }, who: string): void => {
      expect(res.isError, who).toBe(true);
      expect(res.json.error.code, who).toBe('forbidden');
    };

    // A platform administrator who neither owns the app nor collaborates on it deploys it no more than anyone else.
    const admin = await asUser(r, 'admin2@x.y', 'admin');
    expectForbidden(await call(admin.client, 'edit_version', edit), 'admin');

    const former = await asUser(r, 'former@x.y', 'publisher');
    r.h.core.apps.addCollaborator(appId, former.id, r.h.adminId);
    r.h.core.apps.removeCollaborator(appId, former.id, r.h.adminId);
    expectForbidden(await call(former.client, 'edit_version', edit), 'removed collaborator');

    // A disabled collaborator: tested on the function, since the MCP endpoint already turns a disabled account away.
    const disabled = await asUser(r, 'disabled@x.y', 'publisher');
    r.h.core.apps.addCollaborator(appId, disabled.id, r.h.adminId);
    r.h.core.users.setDisabled(disabled.id, true);
    await expect(editVersion(r.h.core, r.h.core.users.get(disabled.id)!, { slug: 'todo', baseVersion: 1, edits: [{ oldText: 'secret', newText: 'open' }] }))
      .rejects.toMatchObject({ code: 'forbidden' });

    // Edits count against the same hourly limit as deploys.
    for (let n = 0; n < DEPLOYS_PER_HOUR; n++) r.h.core.deployLimiter.hit(`app:${appId}`);
    const limited = await call(owner, 'edit_version', edit);
    expect(limited.isError).toBe(true);
    expect(limited.json.error.code).toBe('conflict');
    expect(limited.json.error.message).toContain('limit of deploys');

    expect(r.h.core.apps.listVersions(appId).map((v) => v.number)).toEqual([1]);
    expect((await getVersion(owner, { app: 'todo' })).html).toBe('<p>secret code</p>');
  });

  it('edit_version edits the latest deployed version, also while an instance runs an older one', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>one</p>' });
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>two</p>' });
    await call(client, 'activate_version', { instance: 'todo', version: 1 });

    // The active version is not a base: the edits would be applied to code that is no longer the app's latest.
    const onActive = await call(client, 'edit_version', { slug: 'todo', base_version: 1, edits: [{ old_text: 'one', new_text: 'x' }] });
    expect(onActive.json.error.code).toBe('conflict');
    expect(onActive.json.error.message).toContain('version 2');

    const res = await call(client, 'edit_version', { slug: 'todo', base_version: 2, edits: [{ old_text: 'two', new_text: 'three' }] });
    expect(res.json).toMatchObject({ app: 'todo', version: 3, createdVersion: true });
    expect((await getVersion(client, { app: 'todo' })).html).toBe('<p>three</p>');
  });

  it('edit_version refuses edits that leave an empty document and creates no version', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>one</p>' });
    const res = await call(client, 'edit_version', { slug: 'todo', base_version: 1, edits: [{ old_text: '<p>one</p>', new_text: '' }] });
    expect(res.isError).toBe(true);
    expect(res.json.error.code).toBe('invalid_argument');
    expect(res.json.error.message).toContain('must not be empty');
    expect(r.h.core.apps.listVersions(r.h.core.apps.getApp('todo')!.id)).toHaveLength(1);
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

  it('restore_snapshot and activate_version share the hourly budget of the instance', async () => {
    const r = await start();
    const client = await connect(r);
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>1</p>' });
    await call(client, 'deploy_app', { slug: 'todo', html: '<p>2</p>' });
    await call(client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'tasks/t1', data: { v: 1 } }] });
    // Activating the active version takes no snapshot and is free.
    for (let i = 0; i < 3; i++) expect((await call(client, 'activate_version', { instance: 'todo', version: 2 })).isError).toBe(false);
    for (let i = 0; i < 12; i++) {
      expect((await call(client, 'activate_version', { instance: 'todo', version: 9 })).json.error.code).toBe('not_found');
      expect((await call(client, 'restore_snapshot', { instance: 'todo', snapshot: '20200101T000000000Z-gone' })).json.error.code).toBe('not_found');
    }
    for (let i = 0; i < 9; i++) expect((await call(client, 'activate_version', { instance: 'todo', version: i % 2 === 0 ? 1 : 2 })).isError).toBe(false);
    const snaps = (await call(client, 'list_snapshots', { instance: 'todo' })).json.snapshots as { id: string }[];
    expect(snaps).toHaveLength(9);
    expect((await call(client, 'restore_snapshot', { instance: 'todo', snapshot: snaps[0].id })).isError).toBe(false);
    for (const [tool, args] of [['restore_snapshot', { snapshot: snaps[0].id }], ['activate_version', { version: 2 }]] as const) {
      const refused = await call(client, tool, { instance: 'todo', ...args });
      expect(refused.isError).toBe(true);
      expect(refused.json.error.code).toBe('rate_limited');
    }
    // Attempts that fail validation cost nothing; switching auto-update on would change the version and is refused like the others.
    const auto = await call(client, 'set_auto_update', { instance: 'todo', on: true });
    expect(auto.isError).toBe(true);
    expect(auto.json.error.code).toBe('rate_limited');
    expect((await call(client, 'set_auto_update', { instance: 'todo', on: false })).isError).toBe(false);
    expect(r.h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(1);
    expect((await call(client, 'list_snapshots', { instance: 'todo' })).json.snapshots).toHaveLength(10);
    const { tools } = await client.listTools();
    for (const name of ['activate_version', 'restore_snapshot', 'set_auto_update']) {
      expect(tools.find((t) => t.name === name)!.description, name).toContain('10 per instance and hour');
    }
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

    // A manager lists snapshots but cannot restore: that would roll back data the rules keep from them.
    const adm = r.h.core.users.create({ email: 'adm@x.y', name: 'adm', password: 'pw-adm-12345', role: 'user' });
    r.h.core.access.setGrant(r.h.core.apps.getInstanceBySlug('todo')!, 'user', adm.id, 'admin', r.h.core.users.get(r.h.adminId)!);
    const manager = await connect(r, r.h.core.tokens.create(adm.id, 'mcp').token);
    await call(client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'tasks/t1', data: { v: 3 } }] });
    const listed = await call(manager, 'list_snapshots', { instance: 'todo' });
    expect(listed.isError).toBe(false);
    const refused = await call(manager, 'restore_snapshot', { instance: 'todo', snapshot: listed.json.snapshots[0].id });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe('forbidden');
    expect(r.h.core.data.get(r.h.core.apps.getInstanceBySlug('todo')!.id, 'tasks/t1')!.data).toEqual({ v: 3 });
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
      ['get_version', { app: 'theirs' }],
      ['get_version', { app: 'theirs', version: 1 }],
      ['get_version', { instance: 'theirs' }],
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
    // A path a manager may write but not read: replacing is fine, merging would measure the hidden document.
    await call(owner, 'deploy_app', { slug: 'todo', html: '<p>2</p>', capabilities: { db: { rules: [...rules, { path: 'inbox', read: 'owner', write: 'admin' }] } } });
    await call(owner, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'inbox/a', data: { pad: 'x'.repeat(200 * 1024) } }] });
    const merge = await call(adm.client, 'db_write', { instance: 'todo', ops: [{ op: 'update', path: 'inbox/a', data: { pad2: 'y'.repeat(100 * 1024) } }] });
    expect(merge.isError).toBe(true);
    expect(merge.json.error.code).toBe('forbidden');
    expect(merge.json.error.message).toContain('use set');
    expect(r.h.core.data.get(inst.id, 'inbox/a')!.version).toBe(1);
    expect((await call(adm.client, 'db_write', { instance: 'todo', ops: [{ op: 'set', path: 'inbox/b', data: { v: 1 } }] })).json).toEqual({ applied: 1 });
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

  it('check_app', async () => {
    const r = await start();
    const client = await connect(r);
    const res = await call(client, 'check_app', { html: '<script>lager.use("db"); lager.use("tts"); lager.complete("x")</script>', capabilities: {} });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ used: ['db', 'tts'], unsupported: ['tts'], undeclared: ['db', 'complete'] });
    expect(res.json.warnings).toHaveLength(4);
    expect((await call(client, 'check_app', { html: '<p>x</p>' })).json).toEqual({ used: [], unsupported: [], undeclared: [], warnings: [] });
    const plain = await asUser(r, 'plain@x.y');
    expect((await call(plain.client, 'check_app', { html: '<p>x</p>' })).json.error.code).toBe('forbidden');
  });

  it('no bearer → 401 with WWW-Authenticate resource_metadata', async () => {
    const r = await start();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const auth of [undefined, 'Bearer lgr_wrong', 'Bearer wrong']) {
      const res = await fetch(`${r.base}/mcp`, { method: 'POST', body, headers: auth ? { ...headers, Authorization: auth } : headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${r.base}/.well-known/oauth-protected-resource/mcp"`);
    }
    const get = await fetch(`${r.base}/mcp`, { headers: { Authorization: `Bearer ${r.token}` } });
    expect(get.status).toBe(405);
    const del = await fetch(`${r.base}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${r.token}` } });
    expect(del.status).toBe(405);
  });

  it('the SDK client completes OAuth discovery, consent and token exchange on its own', async () => {
    const r = await start();
    const login = await fetch(`${r.base}/login`, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'admin@x.y', password: 'admin-password-1' }),
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
    expect((await client.listTools()).tools).toHaveLength(25);
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
      const first = await call(client, 'deploy_app', { slug: 'todo', html: '<p>t</p>', icon_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><script>1</script></svg>' });
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

