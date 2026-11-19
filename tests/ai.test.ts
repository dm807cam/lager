import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AiError, AiModels, DEFAULT_GROUP, DEFAULT_HOURLY_LIMIT, DEFAULT_MAX_TOKENS, HOURLY_LIMIT_MAX, MAX_TOKENS_LIMIT, isTruncated, stripReasoning, type AiRoute, type ProviderId } from '../src/platform/ai.js';
import { openPlatformDb } from '../src/platform/db.js';

/** The catalog entry for a provider's model, named after the model; created on first use. */
function entry(ai: AiModels, providerId: string, model: string): string {
  const id = model.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'm';
  return (ai.getModel(id) ?? ai.createModel({ id, providerId, model })).id;
}


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
  ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: null, hourlyLimit: DEFAULT_HOURLY_LIMIT });
  for (const m of ai.listModels()) ai.deleteModel(m.id);
  for (const p of ai.listProviders()) ai.deleteProvider(p.id);
  const p = ai.createProvider({ name: 'P', type: opts.type, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: entry(ai, p.id, opts.model), hourlyLimit: DEFAULT_HOURLY_LIMIT });
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
    expect(ai.listGroups()).toEqual([{ id: DEFAULT_GROUP, name: '', modelId: null, allowed: [], hourlyLimit: DEFAULT_HOURLY_LIMIT, memberCount: 0, isDefault: true }]);
    expect(ai.listModels()).toEqual([]);
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

  it('cannot be deleted while a catalog model uses them', () => {
    const { ai } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    entry(ai, p.id, 'llama3.2');
    expect(ai.modelsUsing(p.id).map((x) => x.id)).toEqual(['llama3.2']);
    expect(() => ai.deleteProvider(p.id)).toThrow(expect.objectContaining({ code: 'conflict', reason: 'ai_provider_in_use' }));
    ai.deleteModel('llama3.2');
    ai.deleteProvider(p.id);
    expect(ai.listProviders()).toEqual([]);
    expect(() => ai.deleteProvider(p.id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('Model catalog', () => {
  it('names models apps can ask for; the name is fixed, the rest can change', () => {
    const { ai } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    const q = ai.createProvider({ name: 'Other', type: 'ollama', baseUrl: 'http://10.0.0.9:11434/v1' });
    expect(ai.createModel({ id: 'fast', providerId: p.id, model: 'llama3.2', description: '  Short   replies ' }))
      .toMatchObject({ id: 'fast', providerId: p.id, model: 'llama3.2', description: 'Short replies' });
    expect(() => ai.createModel({ id: 'fast', providerId: p.id, model: 'x' })).toThrow(expect.objectContaining({ code: 'conflict' }));
    for (const id of ['', 'Fast', '-x', 'has space', 'a'.repeat(41), 'ünï']) {
      expect(() => ai.createModel({ id, providerId: p.id, model: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    expect(() => ai.createModel({ id: 'b', providerId: p.id, model: '' })).toThrow(/model name/);
    expect(() => ai.createModel({ id: 'b', providerId: p.id, model: 'has space' })).toThrow(/model name/);
    expect(() => ai.createModel({ id: 'b', providerId: p.id, model: 'm', description: 'x'.repeat(201) })).toThrow(/description/);
    expect(() => ai.createModel({ id: 'b', providerId: 'nope', model: 'm' })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(ai.updateModel('fast', { id: 'renamed', providerId: q.id, model: 'qwen3' })).toMatchObject({ id: 'fast', providerId: q.id, model: 'qwen3', description: '' });
    expect(() => ai.updateModel('ghost', { providerId: q.id, model: 'm' })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(ai.listModels().map((m) => m.id)).toEqual(['fast']);
  });

  it('cannot delete a group default; deleting another one clears allowed lists and app choices', () => {
    const { ai, db } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    ai.createModel({ id: 'fast', providerId: p.id, model: 'small' });
    ai.createModel({ id: 'smart', providerId: p.id, model: 'big' });
    const g = ai.createGroup({ name: 'Kids', modelId: 'fast', allowed: ['smart', 'fast', 'smart'], hourlyLimit: 5 });
    expect(g.allowed).toEqual(['smart']);
    addUser(db, 'owner');
    db.prepare("INSERT INTO apps (id, slug, title, owner_id, created_at, ai_model_id) VALUES ('a1', 'app', 'App', 'owner', '2026-01-01', 'smart')").run();
    expect(ai.groupsDefaultingTo('fast').map((x) => x.name)).toEqual(['Kids']);
    expect(() => ai.deleteModel('fast')).toThrow(expect.objectContaining({ code: 'conflict', reason: 'ai_model_in_use' }));
    ai.deleteModel('smart');
    expect(ai.getGroup(g.id)!.allowed).toEqual([]);
    expect((db.prepare("SELECT ai_model_id FROM apps WHERE id = 'a1'").get() as { ai_model_id: string | null }).ai_model_id).toBeNull();
    expect(() => ai.deleteModel('smart')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('Model choice per app', () => {
  function catalog() {
    const env = setup();
    const { ai, db } = env;
    const local = ai.createProvider({ name: 'Local', type: 'ollama' });
    const work = ai.createProvider({ name: 'Work', type: 'anthropic', apiKey: 'sk-ant-1' });
    ai.createModel({ id: 'fast', providerId: local.id, model: 'llama3.2', description: 'Quick' });
    ai.createModel({ id: 'smart', providerId: work.id, model: 'claude-opus-5-5' });
    ai.createModel({ id: 'code', providerId: work.id, model: 'claude-sonnet-5-5' });
    const kids = ai.createGroup({ name: 'Kids', modelId: 'fast', hourlyLimit: 5 });
    ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: 'fast', allowed: ['smart'], hourlyLimit: 20 });
    const adult = addUser(db, 'adult');
    const kid = addUser(db, 'kid');
    ai.assign(kid, kids.id);
    return { ...env, local, work, kids, adult, kid };
  }

  it('uses the model the app asks for where the group allows it, else the group default', () => {
    const { ai, work, local, kids, adult, kid } = catalog();
    expect(ai.routeFor(adult, 'smart')).toEqual({ groupId: DEFAULT_GROUP, modelId: 'smart', providerId: work.id, model: 'claude-opus-5-5', hourlyLimit: 20 });
    expect(ai.routeFor(adult, null)).toMatchObject({ modelId: 'fast', providerId: local.id });
    expect(ai.routeFor(adult, 'code')).toMatchObject({ modelId: 'fast' });
    expect(ai.routeFor(adult, 'ghost')).toMatchObject({ modelId: 'fast' });
    expect(ai.routeFor(kid, 'smart')).toEqual({ groupId: kids.id, modelId: 'fast', providerId: local.id, model: 'llama3.2', hourlyLimit: 5 });
  });

  it('falls back to the default when the wanted model cannot be reached, and to the wanted one when the default cannot', () => {
    const { ai, db, adult, work } = catalog();
    db.prepare('UPDATE ai_providers SET key_enc = ? WHERE id = ?').run('v1:broken:x:y', work.id);
    expect(ai.routeFor(adult, 'smart')).toMatchObject({ modelId: 'fast' });
    const fresh = catalog();
    fresh.ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: 'smart', allowed: ['fast'], hourlyLimit: 20 });
    fresh.db.prepare('UPDATE ai_providers SET key_enc = ? WHERE id = ?').run('v1:broken:x:y', fresh.work.id);
    expect(fresh.ai.routeFor(fresh.adult, 'fast')).toMatchObject({ modelId: 'fast' });
    expect(fresh.ai.routeFor(fresh.adult, null)).toBeNull();
  });

  it('lists what each person may choose, default first, and nothing while the group is off', () => {
    const { ai, adult, kid, kids } = catalog();
    expect(ai.allowedModelsFor(adult).map((m) => [m.id, m.providerName, m.isDefault])).toEqual([['fast', 'Local', true], ['smart', 'Work', false]]);
    expect(ai.allowedModelsFor(kid).map((m) => m.id)).toEqual(['fast']);
    expect(ai.mayUse(adult, 'smart')).toBe(true);
    expect(ai.mayUse(kid, 'smart')).toBe(false);
    ai.updateGroup(kids.id, { name: 'Kids', modelId: null, allowed: ['smart'], hourlyLimit: 5 });
    expect(ai.allowedModelsFor(kid)).toEqual([]);
    expect(ai.mayUse(kid, 'smart')).toBe(false);
    expect(ai.routeFor(kid, 'smart')).toBeNull();
  });
});

describe('AI groups', () => {
  it('need a catalog model that exists, and a limit in range', () => {
    const { ai } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    expect(() => ai.createGroup({ name: 'Fam', modelId: 'ghost', hourlyLimit: 5 })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => ai.createGroup({ name: 'Fam', modelId: null, allowed: ['ghost'], hourlyLimit: 5 })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => ai.createGroup({ name: 'Fam', modelId: entry(ai, p.id, 'm'), hourlyLimit: 0 })).toThrow();
    expect(() => ai.createGroup({ name: 'Fam', modelId: entry(ai, p.id, 'm'), hourlyLimit: HOURLY_LIMIT_MAX + 1 })).toThrow();
    expect(() => ai.createGroup({ name: 'Fam', modelId: entry(ai, p.id, 'm'), hourlyLimit: 1.5 })).toThrow();
    expect(ai.listGroups()).toHaveLength(1);
    expect(ai.createGroup({ name: 'Fam', modelId: null, hourlyLimit: 5 })).toMatchObject({ name: 'Fam', modelId: null, allowed: [], isDefault: false });
    expect(() => ai.createGroup({ name: 'FAM', modelId: null, hourlyLimit: 5 })).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('list the default last; it cannot be deleted or renamed', () => {
    const { ai } = setup();
    ai.createGroup({ name: 'Zeta', modelId: null, hourlyLimit: 5 });
    ai.createGroup({ name: 'Alpha', modelId: null, hourlyLimit: 5 });
    expect(ai.listGroups().map((g) => g.name)).toEqual(['Alpha', 'Zeta', '']);
    expect(() => ai.deleteGroup(DEFAULT_GROUP)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(ai.updateGroup(DEFAULT_GROUP, { name: 'X', modelId: null, hourlyLimit: 9 })).toMatchObject({ name: '', hourlyLimit: 9, isDefault: true });
  });

  it('assign each person to one group and resolve their route', () => {
    const { ai, db } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    const g = ai.createGroup({ name: 'Kids', modelId: entry(ai, p.id, 'm-small'), hourlyLimit: 7 });
    const a = addUser(db, 'a');
    const b = addUser(db, 'b');
    ai.assign(a, g.id);
    expect(ai.groupIdOf(a)).toBe(g.id);
    expect(ai.getGroup(g.id)!.memberCount).toBe(1);
    expect(ai.routeFor(a)).toEqual({ groupId: g.id, modelId: 'm-small', providerId: p.id, model: 'm-small', hourlyLimit: 7 });
    expect(ai.groupIdOf(b)).toBe(DEFAULT_GROUP);
    expect(ai.routeFor(b)).toBeNull();
    expect(ai.configured).toBe(true);
    ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: entry(ai, p.id, 'm-big'), hourlyLimit: 3 });
    expect(ai.routeFor(b)).toEqual({ groupId: DEFAULT_GROUP, modelId: 'm-big', providerId: p.id, model: 'm-big', hourlyLimit: 3 });
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
    first.ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: entry(first.ai, p.id, 'gpt-5'), hourlyLimit: 5 });
    const route = first.ai.routeFor('anyone')!;
    const other = new AiModels(first.db, 'another-secret', first.fake);
    expect(other.getProvider(p.id)!.keyHint).toBeNull();
    expect(other.routeFor('anyone')).toBeNull();
    expect(other.configured).toBe(false);
    await expect(other.complete(route, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'not_configured', status: 503 });
    expect(first.sent).toHaveLength(0);
  });

  it('a saved key that no longer decrypts blocks a provider even when its type needs none', async () => {
    const first = setup();
    const p = first.ai.createProvider({ name: 'Proxy', type: 'custom', baseUrl: 'http://10.0.0.5:8000/v1', apiKey: 'sk-proxy-1' });
    first.ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: entry(first.ai, p.id, 'm'), hourlyLimit: 5 });
    const route = first.ai.routeFor('anyone')!;
    const other = new AiModels(first.db, 'another-secret', first.fake);
    expect(other.routeFor('anyone')).toBeNull();
    await expect(other.complete(route, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'not_configured', status: 503 });
    expect(first.sent).toHaveLength(0);
  });

  it('send each route to its own provider with only that provider\'s key', async () => {
    const { ai, db, sent } = setup((s) => s.url.includes('anthropic')
      ? json({ content: [{ type: 'text', text: 'a' }] })
      : json({ choices: [{ message: { content: 'o' } }] }));
    const pa = ai.createProvider({ name: 'A', type: 'anthropic', apiKey: 'sk-ant-1' });
    const po = ai.createProvider({ name: 'O', type: 'openai', apiKey: 'sk-oa-2' });
    const ga = ai.createGroup({ name: 'GA', modelId: entry(ai, pa.id, 'claude-haiku-5-5'), hourlyLimit: 5 });
    const go = ai.createGroup({ name: 'GO', modelId: entry(ai, po.id, 'gpt-5'), hourlyLimit: 5 });
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

  it('test route uses the first catalog model of the provider, else the preset example', () => {
    const { ai } = setup();
    const p = ai.createProvider({ name: 'Local', type: 'ollama' });
    expect(ai.testRoute(p.id)).toMatchObject({ providerId: p.id, model: 'llama3.2' });
    entry(ai, p.id, 'qwen3');
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
    await expect(ai.complete({ groupId: DEFAULT_GROUP, modelId: 'm', providerId: 'nope', model: 'm', hourlyLimit: 1 }, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'not_configured', status: 503 });
    expect(sent).toHaveLength(0);
  });
});
