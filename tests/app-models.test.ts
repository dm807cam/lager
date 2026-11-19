import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { apiExtension } from '../src/http/api.js';
import { manageExtension } from '../src/http/manage.js';
import { csrfToken } from '../src/http/session.js';
import { signToken } from '../src/http/tokens.js';
import { mcpExtension } from '../src/mcp/http.js';
import { DEFAULT_GROUP } from '../src/platform/ai.js';
import { makeHarness, type Harness } from './support/http.js';

/**
 * The language model of an app: the administrator's catalog and the models each AI group allows, what the building AI
 * declares at deploy, what the owner chooses later, and what each viewer's call goes to.
 */

let h: Harness | undefined;
let server: http.Server | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
  h?.core.close();
  h = undefined;
});

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function setup() {
  const asked: string[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    const model = JSON.parse(String(init.body)).model as string;
    asked.push(model);
    return json({ model, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  }) as unknown as typeof fetch;
  server = http.createServer();
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h = makeHarness({ publicUrl: base, extensions: [apiExtension, mcpExtension, manageExtension], fetch: fake });
  server.on('request', h.app);
  const core = h.core;
  const local = core.ai.createProvider({ name: 'Local', type: 'ollama' });
  core.ai.createModel({ id: 'fast', providerId: local.id, model: 'llama3.2', description: 'Quick replies' });
  core.ai.createModel({ id: 'smart', providerId: local.id, model: 'qwen3-big', description: 'Long texts and reasoning' });
  core.ai.createModel({ id: 'code', providerId: local.id, model: 'coder' });
  core.ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: 'fast', allowed: ['smart'], hourlyLimit: 100 });
  const kids = core.ai.createGroup({ name: 'Kids', modelId: 'fast', hourlyLimit: 100 });
  const admin = core.users.get(h.adminId)!;
  const publisher = core.users.create({ email: 'pub@x.y', name: 'Pub', password: 'pw-12345678', role: 'publisher' });
  core.ai.assign(publisher.id, kids.id);
  const kid = core.users.create({ email: 'kid@x.y', name: 'Kid', password: 'pw-12345678', role: 'user' });
  core.ai.assign(kid.id, kids.id);
  const adult = core.users.create({ email: 'adult@x.y', name: 'Adult', password: 'pw-12345678', role: 'user' });
  const tokenOf = (userId: string) => core.tokens.create(userId, 'test').token;
  const mcp = async (userId: string) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokenOf(userId)}` } } }));
    clients.push(client);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return { isError: res.isError === true, json: JSON.parse((res.content as { text: string }[])[0].text) };
    };
  };
  /** Asks the model from an instance page as `user`, who gets interact access first. */
  const ask = async (slug: string, user: { id: string; sessionEpoch: number }) => {
    const inst = core.apps.getInstanceBySlug(slug)!;
    if (user.id !== inst.ownerId) core.access.setGrant(inst, 'user', user.id, 'interact', admin);
    const cookie = 'lager_inst=' + signToken({ uid: user.id, iid: inst.id, k: 'inst', ep: user.sessionEpoch }, 'test-secret', 600);
    const res = await request(h!.app).post('/__lager/complete').set('Host', `${slug}.apps.localhost`).set('X-Lager-Request', '1').set('Cookie', cookie).send({ messages: 'hi' });
    expect(res.status).toBe(200);
    return asked.at(-1);
  };
  return { core, base, admin, publisher, kid, adult, tokenOf, mcp, ask, asked };
}

const html = '<p>chat</p>';

describe('model choice per app', () => {
  it('list_models shows what the caller may choose, and a deploy may only declare one of those', async () => {
    const env = await setup();
    const asAdmin = await env.mcp(env.admin.id);
    expect((await asAdmin('list_models')).json).toEqual({
      models: [
        { name: 'fast', description: 'Quick replies', provider: 'Local', model: 'llama3.2', isDefault: true },
        { name: 'smart', description: 'Long texts and reasoning', provider: 'Local', model: 'qwen3-big', isDefault: false },
      ],
    });
    expect((await asAdmin('deploy_app', { slug: 'chat', html, capabilities: { complete: { model: 'smart' } } })).isError).toBe(false);
    expect((await asAdmin('get_app', { slug: 'chat' })).json.model).toEqual({ chosen: null, declared: 'smart', applies: 'smart' });

    const malformed = await asAdmin('deploy_app', { slug: 'chat', html, capabilities: { complete: { model: 'Smart Model' } } });
    expect(malformed.isError).toBe(true);
    expect(malformed.json.error.message).toContain('complete.model');
    const notOpen = await asAdmin('deploy_app', { slug: 'chat', html, capabilities: { complete: { model: 'code' } } });
    expect(notOpen.isError).toBe(true);
    expect(notOpen.json.error.message).toContain('list_models');
    expect(env.core.apps.listVersions(env.core.apps.getApp('chat')!.id)).toHaveLength(1);

    const asPublisher = await env.mcp(env.publisher.id);
    expect((await asPublisher('list_models')).json.models.map((m: { name: string }) => m.name)).toEqual(['fast']);
    const refused = await asPublisher('deploy_app', { slug: 'homework', html, capabilities: { complete: { model: 'smart' } } });
    expect(refused).toMatchObject({ isError: true, json: { error: { code: 'invalid_argument' } } });
    expect(env.core.apps.getApp('homework')).toBeNull();
    expect((await asPublisher('deploy_app', { slug: 'homework', html, capabilities: { complete: {} } })).isError).toBe(false);
  });

  it('every viewer gets the declared model where their AI group allows it, and the default model of their group otherwise', async () => {
    const env = await setup();
    env.core.apps.deploy({ slug: 'chat', html, userId: env.admin.id, capabilities: { complete: { model: 'smart' } } });
    expect(await env.ask('chat', env.admin)).toBe('qwen3-big');
    expect(await env.ask('chat', env.adult)).toBe('qwen3-big');
    expect(await env.ask('chat', env.kid)).toBe('llama3.2');
    env.core.apps.deploy({ slug: 'plain', html, userId: env.admin.id, capabilities: { complete: {} } });
    expect(await env.ask('plain', env.adult)).toBe('llama3.2');
  });

  it('set_app_model overrides the declaration for every instance until it is set back to null', async () => {
    const env = await setup();
    const asAdmin = await env.mcp(env.admin.id);
    await asAdmin('deploy_app', { slug: 'chat', html, capabilities: { complete: { model: 'smart' } } });
    expect((await asAdmin('set_app_model', { slug: 'chat', model: 'fast' })).json).toEqual({ chosen: 'fast', declared: 'smart', applies: 'fast' });
    expect(await env.ask('chat', env.adult)).toBe('llama3.2');
    // A redeploy keeps the owner's choice.
    await asAdmin('deploy_app', { slug: 'chat', html: '<p>chat 2</p>', capabilities: { complete: { model: 'smart' } } });
    expect(env.core.apps.getApp('chat')!.aiModelId).toBe('fast');
    expect((await asAdmin('set_app_model', { slug: 'chat', model: 'code' })).json.error.message).toContain('not available');
    expect((await asAdmin('set_app_model', { slug: 'chat', model: null })).json).toEqual({ chosen: null, declared: 'smart', applies: 'smart' });
    expect(await env.ask('chat', env.adult)).toBe('qwen3-big');

    const asPublisher = await env.mcp(env.publisher.id);
    expect((await asPublisher('set_app_model', { slug: 'chat', model: 'fast' })).json.error.code).toBe('forbidden');
  });

  it('a collaborator chooses among the models of their own AI group, and an unchanged choice always saves', async () => {
    const env = await setup();
    const app = env.core.apps.deploy({ slug: 'chat', html, userId: env.admin.id, capabilities: { complete: {} } }).app;
    env.core.apps.addCollaborator(app.id, env.publisher.id, env.admin.id);
    env.core.apps.setAiModel(app.id, 'smart');
    const asPublisher = await env.mcp(env.publisher.id);
    expect((await asPublisher('set_app_model', { slug: 'chat', model: 'smart' })).isError).toBe(false);
    expect((await asPublisher('set_app_model', { slug: 'chat', model: 'code' })).isError).toBe(true);
    expect((await asPublisher('set_app_model', { slug: 'chat', model: 'fast' })).json.chosen).toBe('fast');
  });

  it('REST: GET /api/models and PUT /api/apps/:slug/model', async () => {
    const env = await setup();
    env.core.apps.deploy({ slug: 'chat', html, userId: env.admin.id, capabilities: { complete: {} } });
    const auth = { Authorization: `Bearer ${env.tokenOf(env.admin.id)}` };
    const list = await request(env.base).get('/api/models').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.models.map((m: { name: string }) => m.name)).toEqual(['fast', 'smart']);
    const put = await request(env.base).put('/api/apps/chat/model').set(auth).send({ model: 'smart' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ chosen: 'smart', declared: null, applies: 'smart' });
    expect((await request(env.base).put('/api/apps/chat/model').set(auth).send({ model: 5 })).status).toBe(400);
    expect((await request(env.base).put('/api/apps/chat/model').set(auth).send({})).status).toBe(400);
    expect((await request(env.base).put('/api/apps/chat/model').set(auth).send({ model: 'code' })).body.error.code).toBe('invalid_argument');
    expect((await request(env.base).put('/api/apps/chat/model').set(auth).send({ model: null })).body.chosen).toBeNull();
  });

  it('the app page offers the choice to those who deploy an app that calls the model', async () => {
    const env = await setup();
    env.core.apps.deploy({ slug: 'chat', html, userId: env.admin.id, capabilities: { complete: { model: 'smart' } } });
    env.core.apps.deploy({ slug: 'notes', html, userId: env.admin.id, capabilities: { db: {} } });
    const cookie = await h!.login();
    const host = new URL(env.base).host;
    const page = await request(h!.app).get('/apps/chat').set('Host', host).set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<select id="app-model" name="model">');
    expect(page.text).toContain('As the app asks: smart');
    expect(page.text).toContain('fast – Quick replies');
    expect(page.text).not.toContain('>code<');
    expect((await request(h!.app).get('/apps/notes').set('Host', host).set('Cookie', cookie)).text).not.toContain('app-model');

    const csrf = csrfToken(env.core, env.admin);
    const post = (model: string) => request(h!.app).post('/ui/apps/chat/model').set('Host', host).set('Cookie', cookie).type('form').send({ csrf, model });
    expect((await post('fast')).status).toBe(302);
    expect(env.core.apps.getApp('chat')!.aiModelId).toBe('fast');
    const refused = await post('code');
    expect(refused.status).toBe(302);
    expect(refused.headers.location).toContain('flash=');
    expect(env.core.apps.getApp('chat')!.aiModelId).toBe('fast');
    expect((await post('')).status).toBe(302);
    expect(env.core.apps.getApp('chat')!.aiModelId).toBeNull();
  });
});
