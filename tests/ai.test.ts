import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AiError, AiModels, DEFAULT_GROUP, DEFAULT_HOURLY_LIMIT, DEFAULT_MAX_TOKENS, HOURLY_LIMIT_MAX, MAX_TOKENS_LIMIT, isTruncated, stripReasoning, type AiRoute, type ProviderId } from '../src/platform/ai.js';
import { openPlatformDb } from '../src/platform/db.js';

interface Sent { url: string; headers: Record<string, string>; body: any }

let db: DatabaseSync | undefined;
afterEach(() => { db?.close(); db = undefined; });

function setup(reply: (sent: Sent) => Response | Promise<Response> = () => json({}), secret = 's1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-ai-'));
  db = openPlatformDb(dir);
  const sent: Sent[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const s = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    sent.push(s);
    return reply(s);
  }) as unknown as typeof fetch;
  return { ai: new AiModels(db, secret, fake), sent, db, fake };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Connects one provider and points the default AI group at it; returns the route everyone gets. */
function use(ai: AiModels, opts: { type: ProviderId; model: string; apiKey?: string; baseUrl?: string; maxTokens?: number }): AiRoute {
  for (const g of ai.listGroups()) if (!g.isDefault) ai.deleteGroup(g.id);
  ai.updateGroup(DEFAULT_GROUP, { name: '', providerId: null, hourlyLimit: DEFAULT_HOURLY_LIMIT });
  for (const p of ai.listProviders()) ai.deleteProvider(p.id);
  const p = ai.createProvider({ name: 'P', type: opts.type, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  ai.updateGroup(DEFAULT_GROUP, { name: '', providerId: p.id, model: opts.model, hourlyLimit: DEFAULT_HOURLY_LIMIT });
  if (opts.maxTokens !== undefined) ai.setMaxTokens(opts.maxTokens);
  return ai.routeFor('anyone')!;
}

function addUser(d: DatabaseSync, id: string): string {
  d.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'user', 'x', '2026-01-01')").run(id, `${id}@x.test`, id);
  return id;
}

describe('AI providers', () => {
  it('start with none, an Off default group and default limits', () => {
    const { ai } = setup();
    expect(ai.configured).toBe(false);
    expect(ai.listProviders()).toEqual([]);
    expect(ai.listGroups()).toEqual([{ id: DEFAULT_GROUP, name: '', providerId: null, model: '', hourlyLimit: DEFAULT_HOURLY_LIMIT, memberCount: 0, isDefault: true }]);
    expect(ai.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(ai.routeFor('anyone')).toBeNull();
  });

  it('store the key encrypted and show only its end', () => {
    const { ai, db } = setup();
    const p = ai.createProvider({ name: 'Work', type: 'anthropic', apiKey: 'sk-ant-secret-1234' });
    expect(p.keyHint).toBe('…1234');
    const stored = (db.prepare('SELECT key_enc FROM ai_providers WHERE id = ?').get(p.id) as { key_enc: string }).key_enc;
    expect(stored).not.toContain('secret');
    expect(stored.startsWith('v1:')).toBe(true);
  });

  it('keep the key on an edit without one; a new type or address drops it', () => {
    const { ai } = setup();
    const { id } = ai.createProvider({ name: 'Work', type: 'openai', apiKey: 'sk-abcd' });
    expect(ai.updateProvider(id, { name: 'Work', type: 'openai' }).keyHint).toBe('…abcd');
    expect(() => ai.updateProvider(id, { name: 'Work', type: 'openai', baseUrl: 'https://proxy.example/v1' })).toThrow(/needs an API key/);
    expect(ai.getProvider(id)).toMatchObject({ keyHint: '…abcd', baseUrl: '' });
    expect(ai.updateProvider(id, { name: 'Work', type: 'openai', baseUrl: 'https://proxy.example/v1', apiKey: 'sk-new1' })).toMatchObject({ keyHint: '…new1', baseUrl: 'https://proxy.example/v1' });
    expect(ai.updateProvider(id, { name: 'Work', type: 'ollama' }).keyHint).toBeNull();
    expect(ai.updateProvider(id, { name: 'Work', type: 'ollama', apiKey: '' }).keyHint).toBeNull();
  });

  it('have names that are unique ignoring case', () => {
    const { ai } = setup();
    ai.createProvider({ name: 'Work', type: 'ollama' });
    expect(() => ai.createProvider({ name: 'work', type: 'ollama' })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(ai.listProviders()).toHaveLength(1);
  });

  it('reject bad input without storing any of it', () => {
    const { ai } = setup();
    expect(() => ai.createProvider({ name: 'A', type: 'nope' as never })).toThrow();
    expect(() => ai.createProvider({ name: 'A', type: 'custom' })).toThrow(/address/);
    expect(() => ai.createProvider({ name: 'A', type: 'custom', baseUrl: 'ftp://x' })).toThrow(/http/);
    expect(() => ai.createProvider({ name: 'A', type: 'custom', baseUrl: 'https://u:p@x.y' })).toThrow(/http/);
    expect(() => ai.createProvider({ name: 'A', type: 'deepseek' })).toThrow(/needs an API key/);
    expect(() => ai.createProvider({ name: 'A', type: 'openai', apiKey: 'has space' })).toThrow(/key/);
    expect(() => ai.createProvider({ name: '  ', type: 'ollama' })).toThrow();
    expect(() => ai.createProvider({ name: 'x'.repeat(61), type: 'ollama' })).toThrow();
    expect(ai.listProviders()).toEqual([]);
  });

  it('cannot be deleted while an AI group uses them', () => {
    const { ai } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    const g = ai.createGroup({ name: 'Kids', providerId: p.id, model: 'llama3.2', hourlyLimit: 5 });
    expect(ai.groupsUsing(p.id).map((x) => x.name)).toEqual(['Kids']);
    expect(() => ai.deleteProvider(p.id)).toThrow(expect.objectContaining({ code: 'conflict', reason: 'ai_provider_in_use' }));
    ai.deleteGroup(g.id);
    ai.deleteProvider(p.id);
    expect(ai.listProviders()).toEqual([]);
    expect(() => ai.deleteProvider(p.id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('AI groups', () => {
  it('need a model when they have a provider, and a limit in range', () => {
    const { ai } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    expect(() => ai.createGroup({ name: 'Fam', providerId: p.id, model: '', hourlyLimit: 5 })).toThrow(/model/);
    expect(() => ai.createGroup({ name: 'Fam', providerId: p.id, model: 'has space', hourlyLimit: 5 })).toThrow(/model/);
    expect(() => ai.createGroup({ name: 'Fam', providerId: p.id, model: 'm', hourlyLimit: 0 })).toThrow();
    expect(() => ai.createGroup({ name: 'Fam', providerId: p.id, model: 'm', hourlyLimit: HOURLY_LIMIT_MAX + 1 })).toThrow();
    expect(() => ai.createGroup({ name: 'Fam', providerId: p.id, model: 'm', hourlyLimit: 1.5 })).toThrow();
    expect(() => ai.createGroup({ name: 'Fam', providerId: 'nope', model: 'm', hourlyLimit: 5 })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(ai.listGroups()).toHaveLength(1);
    expect(ai.createGroup({ name: 'Fam', providerId: null, model: '', hourlyLimit: 5 })).toMatchObject({ name: 'Fam', providerId: null, isDefault: false });
    expect(() => ai.createGroup({ name: 'FAM', providerId: null, hourlyLimit: 5 })).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('list the default last; it cannot be deleted or renamed', () => {
    const { ai } = setup();
    ai.createGroup({ name: 'Zeta', providerId: null, hourlyLimit: 5 });
    ai.createGroup({ name: 'Alpha', providerId: null, hourlyLimit: 5 });
    expect(ai.listGroups().map((g) => g.name)).toEqual(['Alpha', 'Zeta', '']);
    expect(() => ai.deleteGroup(DEFAULT_GROUP)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(ai.updateGroup(DEFAULT_GROUP, { name: 'X', providerId: null, hourlyLimit: 9 })).toMatchObject({ name: '', hourlyLimit: 9, isDefault: true });
  });

  it('assign each person to one group and resolve their route', () => {
    const { ai, db } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    const g = ai.createGroup({ name: 'Kids', providerId: p.id, model: 'm-small', hourlyLimit: 7 });
    const a = addUser(db, 'a');
    const b = addUser(db, 'b');
    ai.assign(a, g.id);
    expect(ai.groupIdOf(a)).toBe(g.id);
    expect(ai.getGroup(g.id)!.memberCount).toBe(1);
    expect(ai.routeFor(a)).toEqual({ groupId: g.id, providerId: p.id, model: 'm-small', hourlyLimit: 7 });
    expect(ai.groupIdOf(b)).toBe(DEFAULT_GROUP);
    expect(ai.routeFor(b)).toBeNull();
    expect(ai.configured).toBe(true);
    ai.updateGroup(DEFAULT_GROUP, { name: '', providerId: p.id, model: 'm-big', hourlyLimit: 3 });
    expect(ai.routeFor(b)).toEqual({ groupId: DEFAULT_GROUP, providerId: p.id, model: 'm-big', hourlyLimit: 3 });
    ai.assign(a, DEFAULT_GROUP);
    expect((db.prepare('SELECT ai_group_id FROM users WHERE id = ?').get(a) as { ai_group_id: string | null }).ai_group_id).toBeNull();
    ai.assign(a, g.id);
    ai.deleteGroup(g.id);
    expect(ai.groupIdOf(a)).toBe(DEFAULT_GROUP);
    expect(() => ai.assign(a, 'nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => ai.assign('ghost', DEFAULT_GROUP)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('an assignment to a group that vanished counts as the default', () => {
    const { ai, db } = setup();
    const a = addUser(db, 'a');
    db.prepare("UPDATE users SET ai_group_id = 'gone' WHERE id = ?").run(a);
    expect(ai.groupIdOf(a)).toBe(DEFAULT_GROUP);
  });

  it('a key that no longer decrypts makes the route unavailable', async () => {
    const first = setup();
    const p = first.ai.createProvider({ name: 'Work', type: 'openai', apiKey: 'sk-abcd' });
    first.ai.updateGroup(DEFAULT_GROUP, { name: '', providerId: p.id, model: 'gpt-5', hourlyLimit: 5 });
    const route = first.ai.routeFor('anyone')!;
    const other = new AiModels(first.db, 'another-secret', first.fake);
    expect(other.getProvider(p.id)!.keyHint).toBeNull();
    expect(other.routeFor('anyone')).toBeNull();
    expect(other.configured).toBe(false);
    await expect(other.complete(route, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'not_configured', status: 503 });
    expect(first.sent).toHaveLength(0);
  });

  it('send each route to its own provider with only that provider\'s key', async () => {
    const { ai, db, sent } = setup((s) => s.url.includes('anthropic')
      ? json({ content: [{ type: 'text', text: 'a' }] })
      : json({ choices: [{ message: { content: 'o' } }] }));
    const pa = ai.createProvider({ name: 'A', type: 'anthropic', apiKey: 'sk-ant-1' });
    const po = ai.createProvider({ name: 'O', type: 'openai', apiKey: 'sk-oa-2' });
    const ga = ai.createGroup({ name: 'GA', providerId: pa.id, model: 'claude-haiku-5-5', hourlyLimit: 5 });
    const go = ai.createGroup({ name: 'GO', providerId: po.id, model: 'gpt-5', hourlyLimit: 5 });
    const ua = addUser(db, 'ua');
    const uo = addUser(db, 'uo');
    ai.assign(ua, ga.id);
    ai.assign(uo, go.id);
    await ai.complete(ai.routeFor(ua)!, [{ role: 'user', content: 'x' }]);
    await ai.complete(ai.routeFor(uo)!, [{ role: 'user', content: 'x' }]);
    expect(sent[0]).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': 'sk-ant-1' }, body: { model: 'claude-haiku-5-5' } });
    expect(sent[1]).toMatchObject({ url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: 'Bearer sk-oa-2' }, body: { model: 'gpt-5' } });
    expect(JSON.stringify(sent[0].headers)).not.toContain('sk-oa-2');
    expect(JSON.stringify(sent[1].headers)).not.toContain('sk-ant-1');
  });

  it('test route uses the first group model for the provider, else the preset example', () => {
    const { ai } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    expect(ai.testRoute(p.id)).toMatchObject({ providerId: p.id, model: 'llama3.2' });
    ai.createGroup({ name: 'B', providerId: p.id, model: 'qwen3', hourlyLimit: 5 });
    expect(ai.testRoute(p.id).model).toBe('qwen3');
    expect(() => ai.testRoute('nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('longest answer is one global setting', () => {
    const { ai } = setup();
    ai.setMaxTokens(500);
    expect(ai.maxTokens).toBe(500);
    expect(() => ai.setMaxTokens(0)).toThrow();
    expect(() => ai.setMaxTokens(MAX_TOKENS_LIMIT + 1)).toThrow();
    expect(ai.maxTokens).toBe(500);
  });
});

describe('AiModels.complete', () => {
  it('calls the Anthropic Messages API and joins the text blocks', async () => {
    const { ai, sent } = setup(() => json({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }] }));
    const r1 = use(ai, { type: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-1', maxTokens: 1000 });
    const out = await ai.complete(r1, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], { maxTokens: 5000 });
    expect(out).toEqual({ text: 'Hello', model: 'claude-opus-5-5', stopReason: 'end_turn' });
    expect(sent[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0].headers).toMatchObject({ 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' });
    // The administrator's cap wins over what the page asks for.
    expect(sent[0].body).toEqual({ model: 'claude-opus-5-5', max_tokens: 1000, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] });
  });

  it('treats an Anthropic refusal as an error', async () => {
    const { ai } = setup(() => json({ stop_reason: 'refusal', content: [] }));
    const r2 = use(ai, { type: 'anthropic', model: 'm', apiKey: 'k' });
    await expect(ai.complete(r2, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'refused', status: 422 });
  });

  it('calls OpenAI-compatible servers with the right token parameter', async () => {
    const { ai, sent } = setup(() => json({ model: 'gpt-5', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hi there' } }] }));
    const r3 = use(ai, { type: 'openai', model: 'gpt-5', apiKey: 'sk-o', maxTokens: 300 });
    const msgs = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'U' }];
    expect((await ai.complete(r3, msgs)).text).toBe('Hi there');
    expect(sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent[0].headers.authorization).toBe('Bearer sk-o');
    expect(sent[0].body).toEqual({ model: 'gpt-5', messages: msgs, max_completion_tokens: 300 });

    const r4 = use(ai, { type: 'openrouter', model: 'anthropic/claude-opus-5-5', apiKey: 'sk-or' });
    await ai.complete(r4, msgs);
    expect(sent[1].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[1].body.max_tokens).toBe(300);

    const r5 = use(ai, { type: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-d' });
    await ai.complete(r5, msgs);
    expect(sent[2].url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('removes inline reasoning from OpenAI-compatible answers', async () => {
    const reply = (content: string) => () => json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    const cases: Array<[string, string]> = [
      ['<think>use {braces} here</think>\n{"a":1}', '{"a":1}'],
      ['<think>a</think><think>b</think>done', 'done'],
      ['<thinking>plan</thinking><answer>42</answer>', '<thinking>plan</thinking><answer>42</answer>'],
      ['reasoning without opener</think>answer', 'answer'],
      ['<think>ran out of tokens {', ''],
      ['plain', 'plain'],
      // The tags are the answer's own text when they are not at the start.
      ['DeepSeek wraps reasoning in `<think>` tags.', 'DeepSeek wraps reasoning in `<think>` tags.'],
      ['{"html":"<thinking>"}', '{"html":"<thinking>"}'],
      ['<think>a</think>real </think> tail', 'real </think> tail'],
      ['<reasoning>step</reasoning><answer>42</answer>', '<reasoning>step</reasoning><answer>42</answer>'],
    ];
    for (const [input, want] of cases) {
      const { ai } = setup(reply(input));
      const r6 = use(ai, { type: 'deepseek', model: 'm', apiKey: 'k' });
      expect((await ai.complete(r6, [{ role: 'user', content: 'x' }])).text).toBe(want);
    }
  });

  it('strips a long run of reasoning tags in linear time', () => {
    const started = Date.now();
    stripReasoning('<think>'.repeat(40_000));
    stripReasoning('<think>x</think>'.repeat(40_000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('reports whether the answer was cut off', () => {
    expect(isTruncated('max_tokens')).toBe(true);
    expect(isTruncated('length')).toBe(true);
    expect(isTruncated('model_length')).toBe(true);
    expect(isTruncated('end_turn')).toBe(false);
    expect(isTruncated(null)).toBe(false);
  });

  it('uses a custom address and sends no key when there is none', async () => {
    const { ai, sent } = setup(() => json({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }));
    const r7 = use(ai, { type: 'custom', model: 'local', baseUrl: 'http://10.0.0.5:8000/v1/' });
    expect((await ai.complete(r7, [{ role: 'user', content: 'x' }])).text).toBe('ab');
    expect(sent[0].url).toBe('http://10.0.0.5:8000/v1/chat/completions');
    expect(sent[0].headers.authorization).toBeUndefined();
  });

  it('keeps provider details out of the public message', async () => {
    const { ai } = setup(() => json({ error: { message: 'Incorrect API key provided: sk-ab***cd' } }, 401));
    const r8 = use(ai, { type: 'openai', model: 'gpt-5', apiKey: 'sk-abcd' });
    const err = await ai.complete(r8, [{ role: 'user', content: 'x' }]).catch((e: unknown) => e) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toBe('The language model rejected the request (HTTP 401).');
    expect(err.detail).toContain('Incorrect API key');
    expect(err.status).toBe(502);
  });

  it('passes a provider rate limit on as 429', async () => {
    const { ai } = setup(() => json({ error: { message: 'slow down' } }, 429));
    const r9 = use(ai, { type: 'openai', model: 'gpt-5', apiKey: 'k' });
    await expect(ai.complete(r9, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 429 });
  });

  it('reports a network failure and an unreadable answer', async () => {
    const down = setup(() => { throw new TypeError('connect ECONNREFUSED'); });
    const r10 = use(down.ai, { type: 'ollama', model: 'llama3.2' });
    await expect(down.ai.complete(r10, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'provider_error', detail: 'connect ECONNREFUSED' });
    db?.close();
    const odd = setup(() => new Response('not json'));
    const r11 = use(odd.ai, { type: 'ollama', model: 'llama3.2' });
    await expect(odd.ai.complete(r11, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'bad_response' });
  });

  it('refuses to run unconfigured', async () => {
    const { ai, sent } = setup();
    await expect(ai.complete({ groupId: DEFAULT_GROUP, providerId: 'nope', model: 'm', hourlyLimit: 1 }, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'not_configured', status: 503 });
    expect(sent).toHaveLength(0);
  });
});
