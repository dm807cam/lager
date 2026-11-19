import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { adminExtension } from '../src/http/admin.js';
import { signToken } from '../src/http/tokens.js';
import type { Core } from '../src/core.js';
import type { GrantLevel } from '../src/platform/access.js';
import { AiModels, DEFAULT_GROUP, type ProviderId } from '../src/platform/ai.js';
import { RateLimiter } from '../src/http/ratelimit.js';
import { makeHarness, type Harness } from './support/http.js';

/** The catalog entry for a provider's model, named after the model; created on first use. */
function entry(ai: AiModels, providerId: string, model: string): string {
  const id = model.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'm';
  return (ai.getModel(id) ?? ai.createModel({ id, providerId, model })).id;
}


let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const HOST = 'chat.apps.localhost';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(opts: { declare?: boolean; reply?: (body: any) => Response | Promise<Response> } = {}) {
  const sent: any[] = [];
  const urls: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    urls.push(url);
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
  return { core, inst, admin, owner: cookieFor(admin), mk, ask, sent, urls, fake };
}

/** Connects one provider and points the default AI group at it. */
function useModel(core: Core, opts: { type: ProviderId; model: string; apiKey?: string; hourlyLimit?: number }): void {
  const p = core.ai.createProvider({ name: `P-${core.ai.listProviders().length}`, type: opts.type, apiKey: opts.apiKey });
  core.ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: entry(core.ai, p.id, opts.model), hourlyLimit: opts.hourlyLimit ?? 60 });
}

describe('POST /__lager/complete', () => {
  it('answers a declared app once a model is set up', async () => {
    const env = setup();
    expect((await env.ask(env.owner, { messages: 'hi' })).body.error.code).toBe('not_configured');
    useModel(env.core, { type: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-1' });
    const res = await env.ask(env.owner, { messages: [{ role: 'user', content: 'hi' }], system: 'brief', maxTokens: 10 });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ text: 'answer', model: 'claude-opus-5-5', stopReason: 'end_turn', truncated: false });
    expect(env.sent[0]).toMatchObject({ system: 'brief', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('needs the declaration, the header and a viewer who may interact', async () => {
    const env = setup({ declare: false });
    useModel(env.core, { type: 'ollama', model: 'llama3.2' });
    expect((await env.ask(env.owner, { messages: 'hi' })).body.error.code).toBe('not_declared');
    h!.core.close();
    const env2 = setup();
    useModel(env2.core, { type: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' });
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
    useModel(env.core, { type: 'ollama', model: 'llama3.2' });
    for (const body of [{}, { messages: '' }, { messages: [] }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'assistant', content: 'x' }] },
      { messages: 'x', system: 3 }, { messages: 'x', maxTokens: 0 }, { messages: 'x'.repeat(400_001) }]) {
      const res = await env.ask(env.owner, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(env.sent).toHaveLength(0);
  });

  it('limits requests per person and hour', async () => {
    const env = setup({ reply: () => json({ choices: [{ message: { content: 'ok' } }] }) });
    useModel(env.core, { type: 'ollama', model: 'llama3.2', hourlyLimit: 2 });
    expect((await env.ask(env.owner, { messages: 'a' })).status).toBe(200);
    expect((await env.ask(env.owner, { messages: 'b' })).status).toBe(200);
    const third = await env.ask(env.owner, { messages: 'c' });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    // Someone else has a budget of their own.
    expect((await env.ask(env.mk('other@x.y', 'interact'), { messages: 'd' })).status).toBe(200);
  });

  it('routes each person to their AI group\'s model and provider', async () => {
    const env = setup({ reply: () => json({ choices: [{ message: { content: 'ok' } }] }) });
    const pa = env.core.ai.createProvider({ name: 'A', type: 'ollama' });
    const pb = env.core.ai.createProvider({ name: 'B', type: 'custom', baseUrl: 'http://10.0.0.9:8000/v1' });
    const ga = env.core.ai.createGroup({ name: 'GA', modelId: entry(env.core.ai, pa.id, 'a-model'), hourlyLimit: 5 });
    const gb = env.core.ai.createGroup({ name: 'GB', modelId: entry(env.core.ai, pb.id, 'b-model'), hourlyLimit: 5 });
    const u1 = env.mk('u1@x.y', 'interact');
    const u2 = env.mk('u2@x.y', 'interact');
    env.core.ai.assign(env.core.users.getByEmail('u1@x.y')!.id, ga.id);
    env.core.ai.assign(env.core.users.getByEmail('u2@x.y')!.id, gb.id);
    expect((await env.ask(u1, { messages: 'hi' })).body.model).toBe('a-model');
    expect((await env.ask(u2, { messages: 'hi' })).body.model).toBe('b-model');
    expect(env.urls).toEqual(['http://127.0.0.1:11434/v1/chat/completions', 'http://10.0.0.9:8000/v1/chat/completions']);
    expect(env.sent.map((b) => b.model)).toEqual(['a-model', 'b-model']);
  });

  it('a person whose AI group is Off gets not_configured', async () => {
    const env = setup();
    useModel(env.core, { type: 'ollama', model: 'llama3.2' });
    const off = env.core.ai.createGroup({ name: 'None', modelId: null, hourlyLimit: 5 });
    const cookie = env.mk('off@x.y', 'interact');
    env.core.ai.assign(env.core.users.getByEmail('off@x.y')!.id, off.id);
    const res = await env.ask(cookie, { messages: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({ code: 'not_configured', message: 'No language model is available to you.' });
    expect(env.sent).toHaveLength(0);
  });

  it('applies the AI group\'s hourly limit at once when it changes', async () => {
    const env = setup({ reply: () => json({ choices: [{ message: { content: 'ok' } }] }) });
    useModel(env.core, { type: 'ollama', model: 'llama3.2', hourlyLimit: 2 });
    const limit = (n: number) => env.core.ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: entry(env.core.ai, env.core.ai.listProviders()[0].id, 'llama3.2'), hourlyLimit: n });
    expect((await env.ask(env.owner, { messages: 'a' })).status).toBe(200);
    expect((await env.ask(env.owner, { messages: 'b' })).status).toBe(200);
    const third = await env.ask(env.owner, { messages: 'c' });
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBe('60');
    limit(5);
    expect((await env.ask(env.owner, { messages: 'd' })).status).toBe(200);
    limit(1);
    expect((await env.ask(env.owner, { messages: 'e' })).status).toBe(429);
  });

  it('a key that no longer decrypts gives not_configured and sends nothing', async () => {
    const env = setup();
    useModel(env.core, { type: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-1' });
    (env.core as { ai: AiModels }).ai = new AiModels((env.core.ai as unknown as { db: never }).db, 'other-secret', env.fake);
    const res = await env.ask(env.owner, { messages: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('not_configured');
    expect(env.sent).toHaveLength(0);
  });

  it('passes provider failures on without their details', async () => {
    const env = setup({ reply: () => json({ error: { message: 'Incorrect API key provided: sk-ab***cd' } }, 401) });
    useModel(env.core, { type: 'openai', model: 'gpt-5', apiKey: 'sk-abcd' });
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

describe('RateLimiter', () => {
  it('takes a budget per call', () => {
    const l = new RateLimiter(100, 60_000);
    expect(l.hit('k', 1)).toBe(true);
    expect(l.hit('k', 1)).toBe(false);
    expect(l.hit('k', 3)).toBe(true);
  });
});
