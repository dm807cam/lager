import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { adminExtension } from '../src/http/admin.js';
import { csrfToken } from '../src/http/session.js';
import { DEFAULT_GROUP } from '../src/platform/ai.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function setup(reply: () => Response = () => json({ model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }] })) {
  const sent: any[] = [];
  const fake = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return reply(); }) as unknown as typeof fetch;
  h = makeHarness({ fetch: fake, extensions: [adminExtension] });
  const core = h.core;
  const admin = core.users.get(h.adminId)!;
  const cookie = await h.login();
  const csrf = csrfToken(core, admin);
  const get = (path: string) => request(h!.app).get(path).set('Host', h!.host).set('Cookie', cookie);
  const post = (path: string, body: Record<string, string> = {}) => request(h!.app).post(path).set('Host', h!.host).set('Cookie', cookie).type('form').send({ csrf, ...body });
  return { core, admin, get, post, sent };
}

describe('/admin/ai', () => {
  it('adds a provider and an AI group, then assigns a person', async () => {
    const env = await setup();
    expect((await env.get('/admin/ai')).status).toBe(200);
    const add = await env.post('/admin/ai/providers', { name: 'Work', type: 'anthropic', apiKey: 'sk-ant-very-secret-1234', baseUrl: '' });
    expect(add.status).toBe(302);
    const [p] = env.core.ai.listProviders();
    expect(p).toMatchObject({ name: 'Work', type: 'anthropic', keyHint: '…1234' });
    const page = await env.get('/admin/ai');
    expect(page.text).toContain('Work');
    expect(page.text).toContain('…1234');
    expect(page.text).not.toContain('very-secret');

    expect((await env.post('/admin/ai/groups', { name: 'Family', provider: p.id, model: 'claude-haiku-5-5', hourlyLimit: '12' })).status).toBe(302);
    const g = env.core.ai.listGroups().find((x) => x.name === 'Family')!;
    expect(g).toMatchObject({ providerId: p.id, model: 'claude-haiku-5-5', hourlyLimit: 12 });
    expect((await env.get('/admin/ai')).text).toContain('claude-haiku-5-5');

    const u = env.core.users.create({ email: 'kid@x.y', name: 'Kid', password: 'pw-12345678', role: 'user' });
    expect((await env.post(`/admin/users/${u.id}/ai-group`, { group: g.id })).status).toBe(302);
    expect(env.core.ai.groupIdOf(u.id)).toBe(g.id);
    expect((await env.get('/admin/users')).text).toContain(`<option value="${g.id}" selected>`);
  });

  it('edits a provider and a group on their own pages without echoing the key', async () => {
    const env = await setup();
    const p = env.core.ai.createProvider({ name: 'Work', type: 'openai', apiKey: 'sk-very-secret-abcd' });
    const editPage = await env.get(`/admin/ai/providers/${p.id}`);
    expect(editPage.status).toBe(200);
    expect(editPage.text).not.toContain('very-secret');
    expect((await env.post(`/admin/ai/providers/${p.id}`, { name: 'Work 2', type: 'openai', apiKey: '', baseUrl: '' })).status).toBe(302);
    expect(env.core.ai.getProvider(p.id)).toMatchObject({ name: 'Work 2', keyHint: '…abcd' });

    const g = env.core.ai.createGroup({ name: 'Fam', providerId: p.id, model: 'gpt-5', hourlyLimit: 5 });
    expect((await env.get(`/admin/ai/groups/${g.id}`)).status).toBe(200);
    expect((await env.post(`/admin/ai/groups/${g.id}`, { name: 'Fam', provider: '', model: '', hourlyLimit: '3' })).status).toBe(302);
    expect(env.core.ai.getGroup(g.id)).toMatchObject({ providerId: null, hourlyLimit: 3 });

    const def = await env.get(`/admin/ai/groups/${DEFAULT_GROUP}`);
    expect(def.status).toBe(200);
    expect(def.text).not.toContain(`/admin/ai/groups/${DEFAULT_GROUP}/delete`);
    expect(def.text).not.toContain('name="name"');
    expect((await env.post(`/admin/ai/groups/${DEFAULT_GROUP}`, { provider: p.id, model: 'gpt-5-mini', hourlyLimit: '8' })).status).toBe(302);
    expect(env.core.ai.getGroup(DEFAULT_GROUP)).toMatchObject({ providerId: p.id, model: 'gpt-5-mini', hourlyLimit: 8 });
  });

  it('shows the form again with a message for bad input', async () => {
    const env = await setup();
    const bad = await env.post('/admin/ai/providers', { name: 'X', type: 'openai', apiKey: '', baseUrl: '' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('API key');
    expect(env.core.ai.listProviders()).toEqual([]);
    const p = env.core.ai.createProvider({ name: 'Local', type: 'ollama' });
    const noModel = await env.post('/admin/ai/groups', { name: 'G', provider: p.id, model: '', hourlyLimit: '5' });
    expect(noModel.status).toBe(400);
    expect(env.core.ai.listGroups()).toHaveLength(1);
  });

  it('refuses to delete a provider in use and names the AI groups that use it', async () => {
    const env = await setup();
    const p = env.core.ai.createProvider({ name: 'Local', type: 'ollama' });
    env.core.ai.createGroup({ name: 'Grandparents', providerId: p.id, model: 'llama3.2', hourlyLimit: 5 });
    const res = await env.post(`/admin/ai/providers/${p.id}/delete`);
    expect(res.status).toBe(409);
    expect(res.text).toContain('Grandparents');
    expect(env.core.ai.getProvider(p.id)).not.toBeNull();
  });

  it('deletes an AI group and moves its people to Everyone else', async () => {
    const env = await setup();
    const g = env.core.ai.createGroup({ name: 'Fam', providerId: null, hourlyLimit: 5 });
    const u = env.core.users.create({ email: 'a@x.y', name: 'A', password: 'pw-12345678', role: 'user' });
    env.core.ai.assign(u.id, g.id);
    expect((await env.post(`/admin/ai/groups/${g.id}/delete`)).status).toBe(302);
    expect(env.core.ai.groupIdOf(u.id)).toBe(DEFAULT_GROUP);
  });

  it('answers stale ids with a 404 notice', async () => {
    const env = await setup();
    const g = env.core.ai.createGroup({ name: 'Fam', providerId: null, hourlyLimit: 5 });
    env.core.ai.deleteGroup(g.id);
    for (const res of [await env.post(`/admin/ai/groups/${g.id}/delete`), await env.post(`/admin/ai/groups/${g.id}`, { name: 'x', provider: '', hourlyLimit: '5' }),
      await env.get('/admin/ai/providers/nope'), await env.get(`/admin/ai/groups/${g.id}`), await env.post('/admin/ai/providers/nope/test')]) {
      expect(res.status).toBe(404);
      expect(res.text).toContain('no longer exists');
    }
  });

  it('reports a name clash as a conflict', async () => {
    const env = await setup();
    env.core.ai.createProvider({ name: 'Family', type: 'ollama' });
    const res = await env.post('/admin/ai/providers', { name: 'family', type: 'ollama', apiKey: '', baseUrl: '' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('already exists');
    expect(env.core.ai.listProviders()).toHaveLength(1);
  });

  it('cannot delete Everyone else', async () => {
    const env = await setup();
    const res = await env.post(`/admin/ai/groups/${DEFAULT_GROUP}/delete`);
    expect(res.status).toBe(403);
    expect(env.core.ai.getGroup(DEFAULT_GROUP)).not.toBeNull();
  });

  it('tests a provider with the model of its AI group', async () => {
    const env = await setup();
    const p = env.core.ai.createProvider({ name: 'Work', type: 'anthropic', apiKey: 'sk-ant-1' });
    env.core.ai.createGroup({ name: 'Fam', providerId: p.id, model: 'claude-haiku-5-5', hourlyLimit: 5 });
    const res = await env.post(`/admin/ai/providers/${p.id}/test`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('claude-opus-5-5 answered: OK');
    expect(env.sent.at(-1).model).toBe('claude-haiku-5-5');
  });

  it('shows what the provider said when the test fails', async () => {
    const env = await setup(() => json({ error: { message: 'Incorrect API key provided' } }, 401));
    const p = env.core.ai.createProvider({ name: 'Work', type: 'openai', apiKey: 'sk-1' });
    const res = await env.post(`/admin/ai/providers/${p.id}/test`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Incorrect API key provided');
  });

  it('saves the longest answer', async () => {
    const env = await setup();
    expect((await env.post('/admin/ai/max-tokens', { maxTokens: '2000' })).status).toBe(302);
    expect(env.core.ai.maxTokens).toBe(2000);
    expect((await env.post('/admin/ai/max-tokens', { maxTokens: '0' })).status).toBe(400);
    expect(env.core.ai.maxTokens).toBe(2000);
  });

  it('is for administrators only', async () => {
    const env = await setup();
    const pub = env.core.users.create({ email: 'pub@x.y', name: 'P', password: 'pw-12345678', role: 'publisher' });
    const cookie = await h!.login('pub@x.y', 'pw-12345678');
    expect((await request(h!.app).get('/admin/ai').set('Host', h!.host).set('Cookie', cookie)).status).toBe(403);
    const res = await request(h!.app).post(`/admin/users/${pub.id}/ai-group`).set('Host', h!.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(env.core, pub), group: DEFAULT_GROUP });
    expect(res.status).toBe(403);
  });
});
