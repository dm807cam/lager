import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';

/**
 * Bring your own model: the administrator connects language model providers and puts people in AI groups that pick a
 * provider, a model and an hourly limit; apps that declare the `complete` capability call it through `window.claude.complete`. Requests go out with plain `fetch`, either to the Anthropic
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

export const DEFAULT_GROUP = 'default';
const MAX_NAME = 60;

/** A connected provider as the administration page shows it; the key itself never leaves the server, only its last four characters. */
export interface AiProvider { id: string; name: string; type: ProviderId; baseUrl: string; keyHint: string | null; createdAt: string }
export interface AiProviderInput {
  name: string; type: ProviderId; baseUrl?: string;
  /** `undefined` keeps the stored key, `''` removes it. */
  apiKey?: string;
}

/** Who gets which model: every person is in at most one AI group; everyone else is in the default group. */
export interface AiGroup { id: string; name: string; providerId: string | null; model: string; hourlyLimit: number; memberCount: number; isDefault: boolean }
export interface AiGroupInput { name: string; providerId: string | null; model?: string; hourlyLimit: number }

/** What one person's call goes to. */
export interface AiRoute { groupId: string; providerId: string; model: string; hourlyLimit: number }

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

interface ProviderRow { id: string; name: string; type: string; base_url: string | null; key_enc: string | null; created_at: string }
interface GroupRow { id: string; name: string; provider_id: string | null; model: string; hourly_limit: number; member_count: number }

const GROUP_SELECT = `SELECT g.id, g.name, g.provider_id, g.model, g.hourly_limit,
  (SELECT COUNT(*) FROM users u WHERE u.ai_group_id = g.id) AS member_count FROM ai_groups g`;

const bad = (msg: string): never => { throw new LagerError('invalid_argument', msg, 'ai_invalid'); };

function cleanName(name: unknown, what: string): string {
  const v = typeof name === 'string' ? name.trim() : '';
  if (!v || v.length > MAX_NAME) bad(`The ${what} name must be 1 to ${MAX_NAME} characters.`);
  return v;
}

export class AiModels {
  private keyBytes: Buffer;

  constructor(private db: DatabaseSync, secret: string, private fetchImpl: Fetch = (...a) => fetch(...a)) {
    // A key of its own, so the stored API key cannot be read with a session-signing key and the other way round.
    this.keyBytes = crypto.createHash('sha256').update(`lager-ai-key:${secret}`).digest();
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keyBytes, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  /** `null` when nothing is stored or the server secret changed since the key was saved. */
  private decrypt(stored: string | null | undefined): string | null {
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

  // --- longest answer ---

  get maxTokens(): number {
    const n = Number((this.db.prepare("SELECT value FROM settings WHERE key = 'ai_max_tokens'").get() as { value: string } | undefined)?.value);
    return Number.isInteger(n) && n >= 1 && n <= MAX_TOKENS_LIMIT ? n : DEFAULT_MAX_TOKENS;
  }

  setMaxTokens(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > MAX_TOKENS_LIMIT) bad(`The answer length must be a whole number from 1 to ${MAX_TOKENS_LIMIT}.`);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('ai_max_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
  }

  // --- providers ---

  private providerRow(id: string): ProviderRow | undefined {
    return this.db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as ProviderRow | undefined;
  }

  private toProvider(r: ProviderRow): AiProvider {
    const key = this.decrypt(r.key_enc);
    return { id: r.id, name: r.name, type: r.type as ProviderId, baseUrl: r.base_url ?? '', keyHint: key ? `…${key.slice(-4)}` : null, createdAt: r.created_at };
  }

  listProviders(): AiProvider[] {
    return (this.db.prepare('SELECT * FROM ai_providers ORDER BY name COLLATE NOCASE').all() as unknown as ProviderRow[]).map((r) => this.toProvider(r));
  }

  getProvider(id: string): AiProvider | null {
    const r = this.providerRow(id);
    return r ? this.toProvider(r) : null;
  }

  /** Checks a provider form against what is stored (`current`) and returns the row values to write. */
  private validateProvider(input: AiProviderInput, current?: ProviderRow): { name: string; type: ProviderId; baseUrl: string | null; keyEnc: string | null } {
    const name = cleanName(input.name, 'provider');
    if (!isProvider(input.type)) bad('Unknown provider.');
    const preset = PRESETS[input.type];
    const baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (baseUrl) {
      let url: URL | null = null;
      try { url = new URL(baseUrl); } catch { /* checked below */ }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || baseUrl.length > MAX_URL || url.username || url.password) bad('The server address must be an http or https URL.');
    } else if (!preset.baseUrl) bad('Enter the address of the server.');
    const key = input.apiKey === undefined ? undefined : input.apiKey.trim();
    if (key !== undefined && (key.length > MAX_KEY || /\s/.test(key))) bad('The API key looks wrong.');
    // A key goes only where it was entered for: a new type or a new address drops it.
    const moved = !current || current.type !== input.type || (current.base_url ?? '') !== baseUrl;
    const keyAfter = key !== undefined ? key : moved ? '' : (this.decrypt(current?.key_enc) ?? '');
    if (preset.keyRequired && !keyAfter) bad('This provider needs an API key.');
    const keepCipher = key === undefined && !moved && current?.key_enc && keyAfter;
    return { name, type: input.type, baseUrl: baseUrl || null, keyEnc: keepCipher ? current!.key_enc : keyAfter ? this.encrypt(keyAfter) : null };
  }

  private assertProviderNameFree(name: string, exceptId?: string): void {
    const clash = this.db.prepare('SELECT id FROM ai_providers WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
    if (clash && clash.id !== exceptId) throw new LagerError('conflict', `A provider named "${name}" already exists.`, 'ai_name_taken');
  }

  createProvider(input: AiProviderInput): AiProvider {
    const v = this.validateProvider(input);
    this.assertProviderNameFree(v.name);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO ai_providers (id, name, type, base_url, key_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, v.name, v.type, v.baseUrl, v.keyEnc, new Date().toISOString());
    return this.getProvider(id)!;
  }

  updateProvider(id: string, input: AiProviderInput): AiProvider {
    const current = this.providerRow(id);
    if (!current) throw new LagerError('not_found', 'Provider not found.');
    const v = this.validateProvider(input, current);
    this.assertProviderNameFree(v.name, id);
    this.db.prepare('UPDATE ai_providers SET name = ?, type = ?, base_url = ?, key_enc = ? WHERE id = ?').run(v.name, v.type, v.baseUrl, v.keyEnc, id);
    return this.getProvider(id)!;
  }

  groupsUsing(providerId: string): AiGroup[] {
    return this.listGroups().filter((g) => g.providerId === providerId);
  }

  deleteProvider(id: string): void {
    if (!this.providerRow(id)) throw new LagerError('not_found', 'Provider not found.');
    const users = this.groupsUsing(id);
    if (users.length) throw new LagerError('conflict', `The provider is used by ${users.length} AI group(s).`, 'ai_provider_in_use');
    this.db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
  }

  // --- AI groups ---

  private toGroup(r: GroupRow): AiGroup {
    return { id: r.id, name: r.name, providerId: r.provider_id, model: r.model, hourlyLimit: r.hourly_limit, memberCount: r.member_count, isDefault: r.id === DEFAULT_GROUP };
  }

  listGroups(): AiGroup[] {
    const rows = this.db.prepare(`${GROUP_SELECT} ORDER BY g.id = '${DEFAULT_GROUP}', g.name COLLATE NOCASE`).all() as unknown as GroupRow[];
    return rows.map((r) => this.toGroup(r));
  }

  getGroup(id: string): AiGroup | null {
    const r = this.db.prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id) as GroupRow | undefined;
    return r ? this.toGroup(r) : null;
  }

  private validateGroup(input: AiGroupInput, isDefault: boolean): { name: string; providerId: string | null; model: string; hourlyLimit: number } {
    const name = isDefault ? '' : cleanName(input.name, 'AI group');
    const model = (input.model ?? '').trim();
    if (input.providerId !== null) {
      if (!this.providerRow(input.providerId)) throw new LagerError('not_found', 'Provider not found.');
      if (!model || model.length > MAX_MODEL || /\s/.test(model)) bad('Enter the model name without spaces.');
    } else if (model.length > MAX_MODEL || /\s/.test(model)) bad('Enter the model name without spaces.');
    const limit = input.hourlyLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > HOURLY_LIMIT_MAX) bad(`The hourly limit must be a whole number from 1 to ${HOURLY_LIMIT_MAX}.`);
    return { name, providerId: input.providerId, model, hourlyLimit: limit };
  }

  private assertGroupNameFree(name: string, exceptId?: string): void {
    const clash = this.db.prepare(`SELECT id FROM ai_groups WHERE name = ? COLLATE NOCASE AND id != '${DEFAULT_GROUP}'`).get(name) as { id: string } | undefined;
    if (clash && clash.id !== exceptId) throw new LagerError('conflict', `An AI group named "${name}" already exists.`, 'ai_name_taken');
  }

  createGroup(input: AiGroupInput): AiGroup {
    const v = this.validateGroup(input, false);
    this.assertGroupNameFree(v.name);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO ai_groups (id, name, provider_id, model, hourly_limit, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, v.name, v.providerId, v.model, v.hourlyLimit, new Date().toISOString());
    return this.getGroup(id)!;
  }

  updateGroup(id: string, input: AiGroupInput): AiGroup {
    if (!this.getGroup(id)) throw new LagerError('not_found', 'AI group not found.');
    const v = this.validateGroup(input, id === DEFAULT_GROUP);
    if (id !== DEFAULT_GROUP) this.assertGroupNameFree(v.name, id);
    this.db.prepare('UPDATE ai_groups SET name = ?, provider_id = ?, model = ?, hourly_limit = ? WHERE id = ?').run(v.name, v.providerId, v.model, v.hourlyLimit, id);
    return this.getGroup(id)!;
  }

  /** Its people move to the default group. */
  deleteGroup(id: string): void {
    if (id === DEFAULT_GROUP) throw new LagerError('forbidden', 'The default AI group cannot be deleted.', 'ai_default_fixed');
    if (!this.getGroup(id)) throw new LagerError('not_found', 'AI group not found.');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE users SET ai_group_id = NULL WHERE ai_group_id = ?').run(id);
      this.db.prepare('DELETE FROM ai_groups WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- people ---

  groupIdOf(userId: string): string {
    const r = this.db.prepare('SELECT g.id FROM users u JOIN ai_groups g ON g.id = u.ai_group_id WHERE u.id = ?').get(userId) as { id: string } | undefined;
    return r?.id ?? DEFAULT_GROUP;
  }

  assign(userId: string, groupId: string): void {
    if (!this.getGroup(groupId)) throw new LagerError('not_found', 'AI group not found.');
    const res = this.db.prepare('UPDATE users SET ai_group_id = ? WHERE id = ?').run(groupId === DEFAULT_GROUP ? null : groupId, userId);
    if (Number(res.changes) === 0) throw new LagerError('not_found', 'User not found.');
  }

  /** A group's route, or `null` when it is Off, its provider is gone or a required key is missing or unreadable. */
  private routeOf(group: AiGroup | null): AiRoute | null {
    if (!group || !group.providerId || !group.model) return null;
    if (!this.usable(group.providerId)) return null;
    return { groupId: group.id, providerId: group.providerId, model: group.model, hourlyLimit: group.hourlyLimit };
  }

  private usable(providerId: string): boolean {
    const p = this.providerRow(providerId);
    if (!p || !isProvider(p.type)) return false;
    const preset = PRESETS[p.type];
    if (!(p.base_url || preset.baseUrl)) return false;
    return !preset.keyRequired || this.decrypt(p.key_enc) !== null;
  }

  routeFor(userId: string): AiRoute | null {
    return this.routeOf(this.getGroup(this.groupIdOf(userId)));
  }

  /** What the administrator's test button sends to: the model of the first AI group using the provider, else the preset's example. */
  testRoute(providerId: string): AiRoute {
    const p = this.providerRow(providerId);
    if (!p || !isProvider(p.type)) throw new LagerError('not_found', 'Provider not found.');
    const model = this.groupsUsing(providerId).find((g) => g.model)?.model ?? PRESETS[p.type].modelHint;
    return { groupId: '', providerId, model, hourlyLimit: 1 };
  }

  /** Whether anyone can call a model right now. */
  get configured(): boolean {
    return this.listGroups().some((g) => this.routeOf(g) !== null);
  }

  /** Sends one conversation to the route's provider and returns its text answer. */
  async complete(route: AiRoute, messages: ChatMessage[], opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<Completion> {
    const row = this.providerRow(route.providerId);
    if (!row || !isProvider(row.type) || !this.usable(row.id) || !route.model) throw new AiError('not_configured', 'No language model is available to you.', 503);
    const preset = PRESETS[row.type];
    const key = this.decrypt(row.key_enc);
    const model = route.model;
    const maxTokens = Math.min(opts.maxTokens ?? this.maxTokens, this.maxTokens);
    const base = (row.base_url || preset.baseUrl).replace(/\/+$/, '');
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
