import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertCollectionPath } from '../data/paths.js';
import { LagerError } from '../errors.js';
import { RateLimiter } from '../http/ratelimit.js';
import type { Capabilities, DbRule } from './apps.js';

/**
 * Receiving data from outside (ADR 0017): an app declares named endpoints, each of which appends documents to one collection
 * of the instance and can do nothing else. This module holds what the declaration means, the per-instance state of an
 * endpoint (its switch and its token) and everything that bounds how much may come in.
 */

export type IngestAuth = 'none' | 'token';
export interface IngestEndpoint {
  name: string;
  /** The collection the endpoint appends to; the endpoint's name unless declared. */
  collection: string;
  auth: IngestAuth;
  /** Web origins whose pages may call the endpoint, lower case; `["*"]` is any origin and only valid with a token. */
  origins: string[];
  /** Largest request body in bytes. */
  maxBytes: number;
  /** Documents the endpoint takes per UTC day. */
  maxPerDay: number;
  /** What happens when the instance's ingest quota is full: refuse, or drop the oldest received documents of the collection. */
  onFull: 'refuse' | 'rotate';
  /** Adds `_visitor`, a daily hash that tells visitors apart without identifying them. */
  visitor: boolean;
  /** Adds `_country` from the header the operator configured. */
  country: boolean;
}

export const INGEST_LIMITS = {
  /** Endpoints one version may declare. */
  endpoints: 8,
  /** Origins per endpoint. */
  origins: 20,
  /** Request body: the default, and the most an endpoint may ask for. */
  defaultMaxBytes: 4096,
  maxBytes: 64 * 1024,
  /** Documents per endpoint and UTC day: the default, and the most an endpoint may ask for. */
  defaultPerDay: 10_000,
  maxPerDay: 100_000,
  /** Requests per minute: from one client address to one instance, to one endpoint, and to all endpoints of an instance together. */
  perAddress: 150,
  perEndpoint: 600,
  perInstance: 1200,
  /** Wrong tokens per minute from one client address to one instance before further attempts are turned away unchecked. */
  badTokens: 30,
  windowMs: 60_000,
} as const;

const NAME_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const ENDPOINT_KEYS = new Set(['name', 'collection', 'auth', 'origins', 'maxBytes', 'maxPerDay', 'onFull', 'visitor', 'country']);
const TOKEN_PREFIX = 'lgi_';
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `https://host[:port]` in lower case, or null for anything that is not exactly a web origin. */
function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A host name or an address, nothing a browser would never send as its origin: a pattern such as *.example.com matches no page.
  if (!/^([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(url.hostname)) return null;
  // Whatever the parser normalizes away (a path, a default port, upper case) must not have been there: the value is compared as text later.
  return url.origin === value.toLowerCase() ? url.origin : null;
}

function wholeNumber(value: unknown, what: string, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new LagerError('invalid_argument', `${what} must be a whole number from 1 to ${max}.`);
  }
  return value;
}

/**
 * The endpoints of an `ingest` declaration, with defaults filled in. Throws `invalid_argument` with a message for whoever wrote
 * the declaration; nothing is accepted that this function does not understand, so a typo never opens more than was meant.
 */
export function parseIngest(declaration: unknown): IngestEndpoint[] {
  const bad = (msg: string): never => { throw new LagerError('invalid_argument', msg); };
  if (!isObject(declaration)) bad('ingest must be an object.');
  const list = (declaration as Record<string, unknown>).endpoints;
  if (list === undefined) return [];
  if (!Array.isArray(list)) bad('ingest.endpoints must be an array.');
  const entries = list as unknown[];
  if (entries.length > INGEST_LIMITS.endpoints) bad(`ingest.endpoints takes at most ${INGEST_LIMITS.endpoints} endpoints.`);
  const seen = new Set<string>();
  return entries.map((entry): IngestEndpoint => {
    if (!isObject(entry)) return bad('every ingest endpoint must be an object.');
    const name = entry.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) return bad('an ingest endpoint needs a name of lowercase letters, digits, "-" and "_" that starts with a letter (at most 48 characters).');
    const at = `ingest endpoint "${name}"`;
    if (seen.has(name)) bad(`${at} is declared twice.`);
    seen.add(name);
    for (const key of Object.keys(entry)) if (!ENDPOINT_KEYS.has(key)) bad(`${at} has an unknown field "${key}".`);
    const collection = entry.collection === undefined ? name : entry.collection;
    if (typeof collection !== 'string') return bad(`${at}: collection must be a collection path.`);
    try { assertCollectionPath(collection); } catch (e) { bad(`${at}: ${(e as Error).message}`); }
    const segs = collection.toLowerCase().split('/');
    if (segs[0] === 'data' && segs[1] === 'users') bad(`${at}: a private area (data/users/…) cannot receive data.`);
    const auth = entry.auth;
    if (auth !== 'none' && auth !== 'token') return bad(`${at}: auth must be "none" (browsers on the listed origins) or "token".`);
    const rawOrigins = entry.origins === undefined ? [] : entry.origins;
    if (!Array.isArray(rawOrigins) || rawOrigins.length > INGEST_LIMITS.origins) return bad(`${at}: origins must be a list of at most ${INGEST_LIMITS.origins} origins.`);
    const origins = rawOrigins.map((o: unknown): string => {
      if (o === '*') return '*';
      return normalizeOrigin(o) ?? bad(`${at}: "${String(o)}" is not an origin; write it like https://blog.example.com, without a path.`);
    });
    if (origins.includes('*') && (auth !== 'token' || origins.length > 1)) bad(`${at}: origins ["*"] is only allowed alone and with auth "token"; with auth "none" list the websites.`);
    if (auth === 'none' && origins.length === 0) bad(`${at}: auth "none" needs origins, the websites whose pages may send.`);
    const onFull = entry.onFull === undefined ? 'refuse' : entry.onFull;
    if (onFull !== 'refuse' && onFull !== 'rotate') return bad(`${at}: onFull must be "refuse" or "rotate".`);
    if (entry.visitor !== undefined && entry.visitor !== 'daily') bad(`${at}: visitor must be "daily".`);
    if (entry.country !== undefined && typeof entry.country !== 'boolean') bad(`${at}: country must be true or false.`);
    return {
      name, collection, auth, origins: [...new Set(origins)], onFull,
      maxBytes: wholeNumber(entry.maxBytes, `${at}: maxBytes`, INGEST_LIMITS.maxBytes, INGEST_LIMITS.defaultMaxBytes),
      maxPerDay: wholeNumber(entry.maxPerDay, `${at}: maxPerDay`, INGEST_LIMITS.maxPerDay, INGEST_LIMITS.defaultPerDay),
      visitor: entry.visitor === 'daily', country: entry.country === true,
    };
  });
}

/** The endpoints a stored version declares. A declaration that does not parse opens nothing. */
export function ingestEndpoints(caps: Capabilities | undefined): IngestEndpoint[] {
  if (caps?.ingest === undefined) return [];
  try {
    return parseIngest(caps.ingest);
  } catch {
    return [];
  }
}

/**
 * The data rules of a version as the server applies them: the declared ones, and behind them one per ingest endpoint that keeps
 * what arrives from outside to the people who manage the instance. An app opens such a collection to others with a rule of its
 * own for that path, which comes first and so decides.
 */
export function effectiveRules(caps: Capabilities | undefined): DbRule[] | undefined {
  const declared = Array.isArray(caps?.db?.rules) ? caps.db.rules : undefined;
  const endpoints = ingestEndpoints(caps);
  if (endpoints.length === 0) return declared;
  return [...(declared ?? []), ...[...new Set(endpoints.map((e) => e.collection))].map((path): DbRule => ({ path, read: 'admin' }))];
}

export type IngestOutcome = 'accepted' | 'refused' | 'limited';
export interface IngestCounts { accepted: number; refused: number; limited: number }

/** The state, the limits and the counters of the ingest endpoints of all instances. */
export class Ingest {
  /** When counting began: the counters live in memory, so a refused request never costs a write. */
  readonly since = new Date().toISOString();
  /** Budgets of instances and of what is written to: their keys are declared by apps, never chosen by a client. */
  private budgets = new RateLimiter(INGEST_LIMITS.perInstance, INGEST_LIMITS.windowMs, Number.MAX_SAFE_INTEGER);
  /** Budgets of client addresses, kept apart: a flood from many addresses pushes out only records of other addresses. */
  private addresses = new RateLimiter(INGEST_LIMITS.perAddress, INGEST_LIMITS.windowMs);
  private badTokens = new RateLimiter(INGEST_LIMITS.badTokens, INGEST_LIMITS.windowMs);
  private days = new Map<string, { day: string; count: number }>();
  private counts = new Map<string, IngestCounts>();
  private salt: { day: string; key: Buffer } | null = null;

  /** `quotaBytes` is what one instance may hold of documents that came from outside; 0 turns receiving off on this server. */
  constructor(private db: DatabaseSync, private secret: string, readonly quotaBytes: number, readonly countryHeader?: string) {}

  get enabled(): boolean {
    return this.quotaBytes > 0;
  }

  private row(instanceId: string, name: string): { disabled: number; token_generation: number } | undefined {
    return this.db.prepare('SELECT disabled, token_generation FROM ingest_endpoints WHERE instance_id = ? AND name = ?')
      .get(instanceId, name) as { disabled: number; token_generation: number } | undefined;
  }

  /** Whether the people who manage the instance switched this endpoint off. */
  isOff(instanceId: string, name: string): boolean {
    return this.row(instanceId, name)?.disabled === 1;
  }

  setOff(instanceId: string, name: string, off: boolean): void {
    this.db.prepare(
      `INSERT INTO ingest_endpoints (instance_id, name, disabled) VALUES (?, ?, ?)
       ON CONFLICT(instance_id, name) DO UPDATE SET disabled = excluded.disabled`,
    ).run(instanceId, name, off ? 1 : 0);
  }

  /**
   * The endpoint's token. It is derived from the server secret, the instance, the endpoint and a counter, so it can be shown
   * again at any time without being stored, and the platform database alone does not give it away.
   */
  token(instanceId: string, name: string): string {
    const generation = this.row(instanceId, name)?.token_generation ?? 0;
    return TOKEN_PREFIX + crypto.createHmac('sha256', this.secret).update(`ingest-token\n${instanceId}\n${name}\n${generation}`).digest('base64url');
  }

  /** Replaces the token: the old one stops working at once. */
  rotateToken(instanceId: string, name: string): void {
    this.db.prepare(
      `INSERT INTO ingest_endpoints (instance_id, name, token_generation) VALUES (?, ?, 1)
       ON CONFLICT(instance_id, name) DO UPDATE SET token_generation = token_generation + 1`,
    ).run(instanceId, name);
  }

  tokenValid(instanceId: string, name: string, presented: unknown): boolean {
    if (typeof presented !== 'string' || presented.length > 200) return false;
    const expected = Buffer.from(this.token(instanceId, name));
    const actual = Buffer.from(presented);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  /** Whether this address sent so many wrong tokens to the instance that further ones are not looked at for now. */
  tokenGuessesExhausted(instanceId: string, address: string): boolean {
    return this.badTokens.full(`${instanceId}\n${address}`);
  }

  noteBadToken(instanceId: string, address: string): void {
    this.badTokens.hit(`${instanceId}\n${address}`);
  }

  /**
   * Counts one write from outside against the budgets and says whether it may go ahead. `sink` names what is written to (an
   * endpoint, or the rule that lets visitors append); `address` is given for writers nothing else tells apart. The widest
   * budget is asked first and recorded last, so a client at its own limit does not use up what the others share.
   */
  admit(instanceId: string, sink: string, opts: { address?: string; perDay: number }): boolean {
    const all = `${instanceId}\nall`;
    const one = `${instanceId}\nsink\n${sink}`;
    const day = new Date().toISOString().slice(0, 10);
    const today = this.days.get(one);
    const used = today?.day === day ? today.count : 0;
    if (used >= opts.perDay || this.budgets.full(all) || this.budgets.full(one, INGEST_LIMITS.perEndpoint)) return false;
    if (opts.address !== undefined && !this.addresses.hit(`${instanceId}\n${opts.address}`)) return false;
    this.budgets.hit(all);
    this.budgets.hit(one, INGEST_LIMITS.perEndpoint);
    if (today?.day !== day) for (const [key, entry] of this.days) if (entry.day !== day) this.days.delete(key);
    this.days.set(one, { day, count: used + 1 });
    return true;
  }

  note(instanceId: string, name: string, outcome: IngestOutcome): void {
    const key = `${instanceId}\n${name}`;
    const counts = this.counts.get(key) ?? { accepted: 0, refused: 0, limited: 0 };
    counts[outcome] += 1;
    this.counts.set(key, counts);
  }

  countsOf(instanceId: string, name: string): IngestCounts {
    return { ...(this.counts.get(`${instanceId}\n${name}`) ?? { accepted: 0, refused: 0, limited: 0 }) };
  }

  /** Drops what is remembered about a deleted instance; its rows go with the instance. */
  forget(instanceId: string): void {
    const prefix = `${instanceId}\n`;
    for (const map of [this.counts, this.days]) for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    this.budgets.reset(`${instanceId}\nall`);
  }

  /**
   * Tells the visitors of one day apart without identifying them: a keyed hash of the instance, the client address and the
   * browser's user agent. The key is random, exists only in memory and is replaced every UTC day (and at every restart), so a
   * hash cannot be linked to another day or traced back to an address, not even with the server's secret and its database.
   */
  visitorId(instanceId: string, address: string, userAgent: string): string {
    const day = new Date().toISOString().slice(0, 10);
    if (this.salt?.day !== day) this.salt = { day, key: crypto.randomBytes(32) };
    return crypto.createHmac('sha256', this.salt.key).update(`${instanceId}\n${address}\n${userAgent}`).digest('base64url').slice(0, 22);
  }
}
