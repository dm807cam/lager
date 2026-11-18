import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AiError, AiModels, DEFAULT_HOURLY_LIMIT, DEFAULT_MAX_TOKENS, isTruncated, stripReasoning } from '../src/platform/ai.js';
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

describe('AiModels configuration', () => {
  it('starts off and unconfigured with default limits', () => {
    const { ai } = setup();
    expect(ai.configured).toBe(false);
    expect(ai.view()).toEqual({ provider: null, model: '', baseUrl: '', keyHint: null, maxTokens: DEFAULT_MAX_TOKENS, hourlyLimit: DEFAULT_HOURLY_LIMIT });
  });

  it('stores the key encrypted and shows only its end', () => {
    const { ai, db } = setup();
    ai.configure({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-secret-1234' });
    expect(ai.configured).toBe(true);
    expect(ai.view().keyHint).toBe('…1234');
    const stored = (db.prepare("SELECT value FROM settings WHERE key = 'ai_key'").get() as { value: string }).value;
    expect(stored).not.toContain('secret');
    expect(stored.startsWith('v1:')).toBe(true);
  });

  it('an empty key keeps the stored one, switching providers drops it', () => {
    const { ai } = setup();
    ai.configure({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-abcd' });
    ai.configure({ provider: 'openai', model: 'gpt-5-mini' });
    expect(ai.view().keyHint).toBe('…abcd');
    expect(() => ai.configure({ provider: 'deepseek', model: 'deepseek-chat' })).toThrow(/needs an API key/);
    ai.configure({ provider: 'ollama', model: 'llama3.2' });
    expect(ai.view().keyHint).toBeNull();
    expect(ai.configured).toBe(true);
  });

  it('rejects bad input without storing any of it', () => {
    const { ai } = setup();
    expect(() => ai.configure({ provider: 'nope' as never, model: 'x' })).toThrow();
    expect(() => ai.configure({ provider: 'openai', model: 'has space', apiKey: 'k' })).toThrow();
    expect(() => ai.configure({ provider: 'custom', model: 'm' })).toThrow(/address/);
    expect(() => ai.configure({ provider: 'custom', model: 'm', baseUrl: 'ftp://x' })).toThrow(/http/);
    expect(() => ai.configure({ provider: 'custom', model: 'm', baseUrl: 'https://u:p@x.y' })).toThrow(/http/);
    expect(() => ai.configure({ provider: 'openai', model: 'm', apiKey: 'k', maxTokens: 0 })).toThrow();
    expect(() => ai.configure({ provider: 'openai', model: 'm', apiKey: 'k', hourlyLimit: 1.5 })).toThrow();
    expect(ai.view().provider).toBeNull();
  });

  it('turning it off forgets everything but the limits', () => {
    const { ai } = setup();
    ai.configure({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-abcd', maxTokens: 500, hourlyLimit: 5 });
    ai.configure({ provider: null });
    expect(ai.view()).toMatchObject({ provider: null, model: '', keyHint: null, maxTokens: 500, hourlyLimit: 5 });
    expect(ai.configured).toBe(false);
  });

  it('a changed server secret makes the stored key unreadable instead of wrong', () => {
    const first = setup();
    first.ai.configure({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-abcd' });
    const other = new AiModels(first.db, 'another-secret', first.fake);
    expect(other.view().keyHint).toBeNull();
    expect(other.configured).toBe(false);
  });
});

describe('AiModels.complete', () => {
  it('calls the Anthropic Messages API and joins the text blocks', async () => {
    const { ai, sent } = setup(() => json({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }] }));
    ai.configure({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-1', maxTokens: 1000 });
    const out = await ai.complete([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], { maxTokens: 5000 });
    expect(out).toEqual({ text: 'Hello', model: 'claude-opus-5-5', stopReason: 'end_turn' });
    expect(sent[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0].headers).toMatchObject({ 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' });
    // The administrator's cap wins over what the page asks for.
    expect(sent[0].body).toEqual({ model: 'claude-opus-5-5', max_tokens: 1000, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] });
  });

  it('treats an Anthropic refusal as an error', async () => {
    const { ai } = setup(() => json({ stop_reason: 'refusal', content: [] }));
    ai.configure({ provider: 'anthropic', model: 'm', apiKey: 'k' });
    await expect(ai.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'refused', status: 422 });
  });

  it('calls OpenAI-compatible servers with the right token parameter', async () => {
    const { ai, sent } = setup(() => json({ model: 'gpt-5', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hi there' } }] }));
    ai.configure({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-o', maxTokens: 300 });
    const msgs = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'U' }];
    expect((await ai.complete(msgs)).text).toBe('Hi there');
    expect(sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent[0].headers.authorization).toBe('Bearer sk-o');
    expect(sent[0].body).toEqual({ model: 'gpt-5', messages: msgs, max_completion_tokens: 300 });

    ai.configure({ provider: 'openrouter', model: 'anthropic/claude-opus-5-5', apiKey: 'sk-or' });
    await ai.complete(msgs);
    expect(sent[1].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[1].body.max_tokens).toBe(300);

    ai.configure({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-d' });
    await ai.complete(msgs);
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
      ai.configure({ provider: 'deepseek', model: 'm', apiKey: 'k' });
      expect((await ai.complete([{ role: 'user', content: 'x' }])).text).toBe(want);
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
    ai.configure({ provider: 'custom', model: 'local', baseUrl: 'http://10.0.0.5:8000/v1/' });
    expect((await ai.complete([{ role: 'user', content: 'x' }])).text).toBe('ab');
    expect(sent[0].url).toBe('http://10.0.0.5:8000/v1/chat/completions');
    expect(sent[0].headers.authorization).toBeUndefined();
  });

  it('keeps provider details out of the public message', async () => {
    const { ai } = setup(() => json({ error: { message: 'Incorrect API key provided: sk-ab***cd' } }, 401));
    ai.configure({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-abcd' });
    const err = await ai.complete([{ role: 'user', content: 'x' }]).catch((e: unknown) => e) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toBe('The language model rejected the request (HTTP 401).');
    expect(err.detail).toContain('Incorrect API key');
    expect(err.status).toBe(502);
  });

  it('passes a provider rate limit on as 429', async () => {
    const { ai } = setup(() => json({ error: { message: 'slow down' } }, 429));
    ai.configure({ provider: 'openai', model: 'gpt-5', apiKey: 'k' });
    await expect(ai.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 429 });
  });

  it('reports a network failure and an unreadable answer', async () => {
    const down = setup(() => { throw new TypeError('connect ECONNREFUSED'); });
    down.ai.configure({ provider: 'ollama', model: 'llama3.2' });
    await expect(down.ai.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'provider_error', detail: 'connect ECONNREFUSED' });
    db?.close();
    const odd = setup(() => new Response('not json'));
    odd.ai.configure({ provider: 'ollama', model: 'llama3.2' });
    await expect(odd.ai.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'bad_response' });
  });

  it('refuses to run unconfigured', async () => {
    const { ai, sent } = setup();
    await expect(ai.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ reason: 'not_configured', status: 503 });
    expect(sent).toHaveLength(0);
  });
});
