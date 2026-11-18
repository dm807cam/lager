import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';

/**
 * Bring your own model: the administrator connects one language model provider, and apps that declare the `complete`
 * capability call it through `window.claude.complete`. Requests go out with plain `fetch`, either to the Anthropic
 * Messages API or to an OpenAI-compatible chat completions endpoint, which covers most other providers.
 */

export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'deepseek' | 'gemini' | 'mistral' | 'groq' | 'ollama' | 'custom';
type Api = 'anthropic' | 'openai';

export interface Preset {
  /** The provider's name; `ollama` and `custom` get a translated label on the page instead. */
  label: string;
  api: Api;
  /** Base URL without a trailing slash; empty for `custom`, where the administrator must enter one. */
  baseUrl: string;
  /** Shown as the example in the model field. */
  modelHint: string;
  keyRequired: boolean;
  /** OpenAI's newer models reject `max_tokens`; everyone else still expects it. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
}

export const PRESETS: Record<ProviderId, Preset> = {
  anthropic: { label: 'Anthropic (Claude)', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelHint: 'claude-opus-5-5', keyRequired: true, tokenParam: 'max_tokens' },
  openai: { label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-5', keyRequired: true, tokenParam: 'max_completion_tokens' },
  openrouter: { label: 'OpenRouter', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', modelHint: 'anthropic/claude-opus-5-5', keyRequired: true, tokenParam: 'max_tokens' },
  deepseek: { label: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat', keyRequired: true, tokenParam: 'max_tokens' },
  gemini: { label: 'Google Gemini', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelHint: 'gemini-2.5-flash', keyRequired: true, tokenParam: 'max_tokens' },
  mistral: { label: 'Mistral', api: 'openai', baseUrl: 'https://api.mistral.ai/v1', modelHint: 'mistral-large-latest', keyRequired: true, tokenParam: 'max_tokens' },
  groq: { label: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', modelHint: 'llama-3.3-70b-versatile', keyRequired: true, tokenParam: 'max_tokens' },
  ollama: { label: 'Ollama', api: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', modelHint: 'llama3.2', keyRequired: false, tokenParam: 'max_tokens' },
  custom: { label: '', api: 'openai', baseUrl: '', modelHint: 'model-name', keyRequired: false, tokenParam: 'max_tokens' },
};
export const PROVIDER_IDS = Object.keys(PRESETS) as ProviderId[];

/** What the administrator's test button sends. */
export const TEST_PROMPT = 'Reply with the single word OK.';

export const MAX_TOKENS_LIMIT = 128_000;
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_HOURLY_LIMIT = 60;
export const HOURLY_LIMIT_MAX = 10_000;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_MODEL = 200;
const MAX_KEY = 1000;
const MAX_URL = 500;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** What the administration page shows; the key itself never leaves the server, only its last four characters. */
export interface AiConfigView {
  provider: ProviderId | null; model: string; baseUrl: string; keyHint: string | null;
  maxTokens: number; hourlyLimit: number;
}

export interface AiConfigInput {
  provider: ProviderId | null; model?: string; baseUrl?: string;
  /** `undefined` keeps the stored key, `''` removes it. */
  apiKey?: string;
  maxTokens?: number; hourlyLimit?: number;
}

export interface Completion { text: string; model: string; stopReason: string | null }

/** Whether the provider stopped because the answer hit the length limit (Anthropic `max_tokens`, OpenAI `length`, Mistral `model_length`). */
export const isTruncated = (stopReason: string | null): boolean => stopReason === 'max_tokens' || stopReason === 'length' || stopReason === 'model_length' || stopReason === 'model_context_window_exceeded';

/**
 * A provider call that failed. `message` is safe to show any viewer of an app; `detail` carries what the provider said
 * and is shown to administrators only (it can name the account or the model).
 */
export class AiError extends Error {
  constructor(public reason: 'not_configured' | 'provider_error' | 'timeout' | 'refused' | 'bad_response', message: string, public status = 502, public detail = '') {
    super(message);
    this.name = 'AiError';
  }
}

type Fetch = typeof fetch;

const isProvider = (v: unknown): v is ProviderId => typeof v === 'string' && Object.hasOwn(PRESETS, v);

export class AiModels {
  private keyBytes: Buffer;

  constructor(private db: DatabaseSync, secret: string, private fetchImpl: Fetch = (...a) => fetch(...a)) {
    // A key of its own, so the stored API key cannot be read with a session-signing key and the other way round.
    this.keyBytes = crypto.createHash('sha256').update(`lager-ai-key:${secret}`).digest();
  }

  private read(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  private write(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keyBytes, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  /** `null` when nothing is stored or the server secret changed since the key was saved. */
  private decrypt(stored: string | undefined): string | null {
    if (!stored) return null;
    const [v, iv, tag, ct] = stored.split(':');
    if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.keyBytes, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private intSetting(key: string, fallback: number, min: number, max: number): number {
    const n = Number(this.read(key));
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  }

  get provider(): ProviderId | null {
    const v = this.read('ai_provider');
    return isProvider(v) ? v : null;
  }

  get maxTokens(): number { return this.intSetting('ai_max_tokens', DEFAULT_MAX_TOKENS, 1, MAX_TOKENS_LIMIT); }
  get hourlyLimit(): number { return this.intSetting('ai_hourly_limit', DEFAULT_HOURLY_LIMIT, 1, HOURLY_LIMIT_MAX); }

  private apiKey(): string | null { return this.decrypt(this.read('ai_key')); }

  /** The base URL in use: the stored override, else the preset's. */
  private baseUrl(provider: ProviderId): string {
    return (this.read('ai_base_url') || PRESETS[provider].baseUrl).replace(/\/+$/, '');
  }

  view(): AiConfigView {
    const provider = this.provider;
    const key = this.apiKey();
    return {
      provider, model: this.read('ai_model') ?? '', baseUrl: this.read('ai_base_url') ?? '',
      keyHint: key ? `…${key.slice(-4)}` : null, maxTokens: this.maxTokens, hourlyLimit: this.hourlyLimit,
    };
  }

  /** Whether apps can call a model right now. */
  get configured(): boolean {
    const provider = this.provider;
    if (!provider || !this.read('ai_model')) return false;
    if (!this.baseUrl(provider)) return false;
    return !PRESETS[provider].keyRequired || this.apiKey() !== null;
  }

  /** Validates everything before storing anything. `provider: null` turns the feature off and forgets the key. */
  configure(input: AiConfigInput): void {
    const bad = (msg: string): never => { throw new LagerError('invalid_argument', msg, 'ai_invalid'); };
    if (input.provider === null) {
      for (const k of ['ai_provider', 'ai_model', 'ai_base_url', 'ai_key']) this.write(k, null);
      return;
    }
    if (!isProvider(input.provider)) bad('Unknown provider.');
    const preset = PRESETS[input.provider];
    const model = (input.model ?? '').trim();
    if (!model || model.length > MAX_MODEL || /\s/.test(model)) bad('Enter the model name without spaces.');
    const baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (baseUrl) {
      let url: URL | null = null;
      try { url = new URL(baseUrl); } catch { /* checked below */ }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || baseUrl.length > MAX_URL || url.username || url.password) bad('The server address must be an http or https URL.');
    } else if (!preset.baseUrl) bad('Enter the address of the server.');
    const key = input.apiKey === undefined ? undefined : input.apiKey.trim();
    if (key !== undefined && (key.length > MAX_KEY || /\s/.test(key))) bad('The API key looks wrong.');
    // Switching providers drops the old key: a key for one provider is never sent to another.
    const switching = this.provider !== input.provider;
    const keyAfter = key !== undefined ? key : switching ? '' : (this.apiKey() ?? '');
    if (preset.keyRequired && !keyAfter) bad('This provider needs an API key.');
    const maxTokens = input.maxTokens ?? this.maxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_LIMIT) bad(`The answer length must be a whole number from 1 to ${MAX_TOKENS_LIMIT}.`);
    const hourlyLimit = input.hourlyLimit ?? this.hourlyLimit;
    if (!Number.isInteger(hourlyLimit) || hourlyLimit < 1 || hourlyLimit > HOURLY_LIMIT_MAX) bad(`The hourly limit must be a whole number from 1 to ${HOURLY_LIMIT_MAX}.`);
    this.write('ai_provider', input.provider);
    this.write('ai_model', model);
    this.write('ai_base_url', baseUrl || null);
    if (key !== undefined || switching) this.write('ai_key', keyAfter ? this.encrypt(keyAfter) : null);
    this.write('ai_max_tokens', String(maxTokens));
    this.write('ai_hourly_limit', String(hourlyLimit));
  }

  /** Sends one conversation to the configured model and returns its text answer. */
  async complete(messages: ChatMessage[], opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<Completion> {
    const provider = this.provider;
    const model = this.read('ai_model') ?? '';
    if (!provider || !this.configured) throw new AiError('not_configured', 'No language model is set up on this server.', 503);
    const preset = PRESETS[provider];
    const key = this.apiKey();
    const maxTokens = Math.min(opts.maxTokens ?? this.maxTokens, this.maxTokens);
    const base = this.baseUrl(provider);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let url: string;
    let headers: Record<string, string>;
    let body: Record<string, unknown>;
    if (preset.api === 'anthropic') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      url = `${base}/messages`;
      headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) };
      body = { model, max_tokens: maxTokens, messages: messages.filter((m) => m.role !== 'system'), ...(system ? { system } : {}) };
    } else {
      url = `${base}/chat/completions`;
      headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
      body = { model, messages, [preset.tokenParam]: maxTokens };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    } catch (e) {
      if (timeout.aborted) throw new AiError('timeout', 'The language model took too long to answer.', 504);
      throw new AiError('provider_error', 'The language model could not be reached.', 502, e instanceof Error ? e.message : String(e));
    }
    const raw = await readCapped(res);
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { /* reported below */ }
    if (!res.ok) {
      const detail = providerMessage(json) ?? raw.slice(0, 300);
      const status = res.status === 429 ? 429 : 502;
      throw new AiError('provider_error', res.status === 429 ? 'The language model is busy; try again shortly.' : `The language model rejected the request (HTTP ${res.status}).`, status, detail);
    }
    return preset.api === 'anthropic' ? parseAnthropic(json, model) : parseOpenAi(json, model);
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AiError('bad_response', 'The language model sent an answer that is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Both API families put a readable message at `error.message`; some proxies put a string at `error`. */
function providerMessage(json: unknown): string | null {
  if (!isObj(json)) return null;
  const err = json.error;
  if (typeof err === 'string') return err.slice(0, 300);
  if (isObj(err) && typeof err.message === 'string') return err.message.slice(0, 300);
  return typeof json.message === 'string' ? json.message.slice(0, 300) : null;
}

function parseAnthropic(json: unknown, model: string): Completion {
  if (!isObj(json) || !Array.isArray(json.content)) throw new AiError('bad_response', 'The language model sent an answer Lager cannot read.');
  const stopReason = typeof json.stop_reason === 'string' ? json.stop_reason : null;
  // The model declined; its content, if any, is not an answer.
  if (stopReason === 'refusal') throw new AiError('refused', 'The language model declined to answer.', 422);
  // Only text blocks are the answer: thinking blocks and anything newer are left out.
  const text = json.content.filter((b): b is { type: 'text'; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  return { text, model: typeof json.model === 'string' ? json.model : model, stopReason };
}

/**
 * Reasoning models served over OpenAI-compatible APIs (DeepSeek, Ollama, Groq and others) often put their reasoning
 * inline at the start of `content`. It is not the answer, and its braces and prose break apps that parse the reply,
 * so it is cut. Only the start of the reply is touched: the tags in the middle of an answer are the answer's own text
 * (an app may ask for a `<thinking>` or `<reasoning>` section and parse it; only `<think>`, what reasoning models send, is removed), and every pass scans each part of the text at most once.
 */
export function stripReasoning(text: string): string {
  let out = text;
  let stripped = false;
  for (;;) {
    const closed = out.replace(/^\s*<think>[\s\S]*?<\/think>/i, '');
    if (closed === out) break;
    out = closed;
    stripped = true;
  }
  // Reasoning that ran out of tokens never closes: nothing after the opener is an answer.
  if (/^\s*<think>/i.test(out)) return '';
  // Some servers drop the opening tag and send only `reasoning</think>answer`; the closer is then the first tag.
  // (An answer that is plain prose and mentions a literal `</think>` with no opener anywhere is cut too; that is rarer.)
  if (!stripped && !/<think>/i.test(out)) out = out.replace(/^[^<]*<\/think>/i, '');
  return out.trim();
}

function parseOpenAi(json: unknown, model: string): Completion {
  const choice = isObj(json) && Array.isArray(json.choices) ? json.choices[0] : undefined;
  const message = isObj(choice) ? choice.message : undefined;
  if (!isObj(message)) throw new AiError('bad_response', 'The language model sent an answer Lager cannot read.');
  const content = message.content;
  // Some servers return content as a list of parts.
  const text = stripReasoning(typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : '')).join('')
      : '');
  if (!text && typeof message.refusal === 'string' && message.refusal) throw new AiError('refused', 'The language model declined to answer.', 422);
  const finish = isObj(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  return { text, model: isObj(json) && typeof json.model === 'string' ? json.model : model, stopReason: finish };
}
