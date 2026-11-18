import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { adminExtension } from '../src/http/admin.js';
import { csrfToken } from '../src/http/session.js';
import { signToken } from '../src/http/tokens.js';
import type { GrantLevel } from '../src/platform/access.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const HOST = 'chat.apps.localhost';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(opts: { declare?: boolean; reply?: (body: any) => Response | Promise<Response> } = {}) {
  const sent: any[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    return opts.reply ? opts.reply(body) : json({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }] });
  }) as unknown as typeof fetch;
  h = makeHarness({ fetch: fake, extensions: [adminExtension] });
  const core = h.core;
  const inst = core.apps.deploy({ slug: 'chat', html: '<p>chat</p>', userId: h.adminId, capabilities: opts.declare === false ? {} : { complete: {} } }).instances[0];
  const admin = core.users.get(h.adminId)!;
  const cookieFor = (u: { id: string; sessionEpoch: number }) => 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst', ep: u.sessionEpoch }, 'test-secret', 600);
  const mk = (email: string, level: GrantLevel) => {
    const u = core.users.create({ email, name: email, password: 'pw-12345678', role: 'user' });
    core.access.setGrant(inst, 'user', u.id, level, admin);
    return cookieFor(u);
  };
  const ask = (cookie: string | undefined, body: unknown) => {
    const r = request(h!.app).post('/__lager/complete').set('Host', HOST).set('X-Lager-Request', '1');
    return (cookie ? r.set('Cookie', cookie) : r).send(body as object);
  };
  return { core, inst, admin, owner: cookieFor(admin), mk, ask, sent };
}

describe('POST /__lager/complete', () => {
  it('answers a declared app once a model is set up', async () => {
    const env = setup();
    expect((await env.ask(env.owner, { messages: 'hi' })).body.error.code).toBe('not_configured');
    env.core.ai.configure({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-1' });
    const res = await env.ask(env.owner, { messages: [{ role: 'user', content: 'hi' }], system: 'brief', maxTokens: 10 });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ text: 'answer', model: 'claude-opus-5-5', stopReason: 'end_turn' });
    expect(env.sent[0]).toMatchObject({ system: 'brief', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('needs the declaration, the header and a viewer who may interact', async () => {
    const env = setup({ declare: false });
    env.core.ai.configure({ provider: 'ollama', model: 'llama3.2' });
    expect((await env.ask(env.owner, { messages: 'hi' })).body.error.code).toBe('not_declared');
    h!.core.close();
    const env2 = setup();
    env2.core.ai.configure({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' });
    const noHeader = await request(h!.app).post('/__lager/complete').set('Host', HOST).set('Cookie', env2.owner).send({ messages: 'hi' });
    expect(noHeader.status).toBe(403);
    expect((await env2.ask(env2.mk('viewer@x.y', 'view'), { messages: 'hi' })).status).toBe(403);
    expect((await env2.ask(env2.mk('helper@x.y', 'interact'), { messages: 'hi' })).status).toBe(200);
    // A guest on a public instance can open the app but not spend the server's credit.
    env2.core.apps.setVisibility(env2.inst.id, 'public', env2.admin.id);
    expect((await env2.ask(undefined, { messages: 'hi' })).status).toBe(401);
    expect(env2.sent).toHaveLength(1);
  });

  it('validates the conversation', async () => {
    const env = setup();
    env.core.ai.configure({ provider: 'ollama', model: 'llama3.2' });
    for (const body of [{}, { messages: '' }, { messages: [] }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'assistant', content: 'x' }] },
      { messages: 'x', system: 3 }, { messages: 'x', maxTokens: 0 }, { messages: 'x'.repeat(400_001) }]) {
      const res = await env.ask(env.owner, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(env.sent).toHaveLength(0);
  });

  it('limits requests per person and hour', async () => {
    const env = setup({ reply: () => json({ choices: [{ message: { content: 'ok' } }] }) });
    env.core.ai.configure({ provider: 'ollama', model: 'llama3.2', hourlyLimit: 2 });
    expect((await env.ask(env.owner, { messages: 'a' })).status).toBe(200);
    expect((await env.ask(env.owner, { messages: 'b' })).status).toBe(200);
    const third = await env.ask(env.owner, { messages: 'c' });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    // Someone else has a budget of their own.
    expect((await env.ask(env.mk('other@x.y', 'interact'), { messages: 'd' })).status).toBe(200);
  });

  it('passes provider failures on without their details', async () => {
    const env = setup({ reply: () => json({ error: { message: 'Incorrect API key provided: sk-ab***cd' } }, 401) });
    env.core.ai.configure({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-abcd' });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      const res = await env.ask(env.owner, { messages: 'hi' });
      expect(res.status).toBe(502);
      expect(res.body.error).toEqual({ code: 'provider_error', message: 'The language model rejected the request (HTTP 401).' });
      expect(res.text).not.toContain('Incorrect');
    } finally { console.error = orig; }
    expect(String(errors[0])).toContain('Incorrect API key');
  });
});

describe('/admin/ai', () => {
  it('saves the provider, never shows the key and runs a test', async () => {
    const env = setup({ reply: () => json({ model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }] }) });
    const cookie = await h!.login();
    const csrf = csrfToken(env.core, env.admin);
    const page = await request(h!.app).get('/admin/ai').set('Host', h!.host).set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="provider"');
    const save = await request(h!.app).post('/admin/ai').set('Host', h!.host).set('Cookie', cookie).type('form')
      .send({ csrf, provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-very-secret-9876', baseUrl: '', maxTokens: '2000', hourlyLimit: '30' });
    expect(save.status).toBe(302);
    expect(env.core.ai.view()).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', keyHint: '…9876', maxTokens: 2000, hourlyLimit: 30 });
    const after = await request(h!.app).get('/admin/ai').set('Host', h!.host).set('Cookie', cookie);
    expect(after.text).not.toContain('very-secret');
    expect(after.text).toContain('…9876');
    const test = await request(h!.app).post('/admin/ai/test').set('Host', h!.host).set('Cookie', cookie).type('form').send({ csrf });
    expect(test.status).toBe(200);
    expect(test.text).toContain('claude-opus-5-5 answered: OK');
    expect(env.sent.at(-1).messages[0].role).toBe('user');
  });

  it('shows the form again with a message for bad input, and Off turns it off', async () => {
    const env = setup();
    const cookie = await h!.login();
    const csrf = csrfToken(env.core, env.admin);
    const bad = await request(h!.app).post('/admin/ai').set('Host', h!.host).set('Cookie', cookie).type('form')
      .send({ csrf, provider: 'openai', model: '', apiKey: '', maxTokens: '100', hourlyLimit: '10' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('enter the model name');
    env.core.ai.configure({ provider: 'ollama', model: 'llama3.2' });
    await request(h!.app).post('/admin/ai').set('Host', h!.host).set('Cookie', cookie).type('form').send({ csrf, provider: '' });
    expect(env.core.ai.configured).toBe(false);
  });

  it('is for administrators only', async () => {
    const env = setup();
    env.core.users.create({ email: 'pub@x.y', name: 'P', password: 'pw-12345678', role: 'publisher' });
    const cookie = await h!.login('pub@x.y', 'pw-12345678');
    expect((await request(h!.app).get('/admin/ai').set('Host', h!.host).set('Cookie', cookie)).status).toBe(403);
  });
});
