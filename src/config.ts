import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LagerError } from './errors.js';
import { isLocale, LOCALES, type Locale } from './i18n/index.js';

export interface Config {
  dataDir: string;
  port: number;
  /** Address the server binds to (LAGER_HOST); unset = every interface. */
  host?: string;
  /** One line per finished request on stdout (LAGER_ACCESS_LOG). */
  accessLog?: boolean;
  publicUrl: URL;
  appsDomain: string;
  adminEmail?: string;
  adminPassword?: string;
  secret: string;
  /** True when LAGER_SECRET came from the environment and is shorter than MIN_SECRET_LENGTH; `createCore` decides what that means. */
  weakSecret?: boolean;
  snapshotKeep: number;
  /** Express `trust proxy` setting: number of trusted proxy hops, or false for none. */
  trustProxy: number | false;
  /** SMTP connection URL (LAGER_SMTP_URL), e.g. smtp://user:pass@host:587. Mail is disabled without it. */
  smtpUrl?: string;
  /** Sender of outgoing mail (LAGER_MAIL_FROM). */
  mailFrom?: string;
  /** Maximum size of one instance's data (LAGER_INSTANCE_QUOTA_MB, default 50 MiB). */
  instanceQuotaBytes: number;
  /** Language used when neither the account, a cookie nor the browser names a supported one (LAGER_DEFAULT_LOCALE, default `en`). */
  defaultLocale: Locale;
  /** Days deleted instance data and app versions stay in `<dataDir>/trash` (LAGER_TRASH_DAYS, default 30; 0 = keep forever). */
  trashDays?: number;
  /** How long one language model request may take (LAGER_AI_TIMEOUT_SECONDS, default 90). */
  aiTimeoutSeconds?: number;
}

/** Longest instance name (a DNS label). */
export const MAX_SLUG_LENGTH = 63;
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** App and instance ids are UUIDs; a slug of that shape would be ambiguous wherever a slug or an id is accepted. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Names no new app or instance may take: Lager's own, and names that would lend a publisher's page the look of an official
 * address (`login.<apps domain>`) or collide with common infrastructure. Apps that already have such a name keep working.
 */
const RESERVED_SLUGS = new Set([
  'www', 'api', 'lager', 'admin', 'mcp', 'auth', 'static',
  'login', 'account', 'accounts', 'mail', 'smtp', 'ftp', 'assets', 'cdn', 'status', 'support', 'security',
]);

/** The shape of a slug only; every name that exists passes this. */
export function assertSlugShape(slug: string): void {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new LagerError('invalid_argument', `Invalid slug "${slug}": use lowercase letters, digits and hyphens (max ${MAX_SLUG_LENGTH} characters).`, 'slug_invalid');
  }
}

/** A slug a new app or instance may take: well-formed and not reserved. */
export function assertSlug(slug: string): void {
  assertSlugShape(slug);
  if (RESERVED_SLUGS.has(slug) || UUID_RE.test(slug)) {
    throw new LagerError('invalid_argument', `Slug "${slug}" is reserved.`, 'slug_reserved');
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function loadSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

/** A whole number written in digits (no sign, fraction or exponent) between `min` and `max`. */
function parseIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `${min} or more` : `between ${min} and ${max}`;
    throw new Error(`${name} must be a whole number, ${range} (it is "${raw}")`);
  }
  return n;
}

/** The platform address: http or https, a host and optionally a port, nothing after it. */
function parsePublicUrl(raw: string): URL {
  const example = 'for example https://lager.example.com';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LAGER_PUBLIC_URL must be a full address, ${example} (it is "${raw}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`LAGER_PUBLIC_URL must start with http:// or https://, ${example} (it is "${raw}")`);
  // Comparing the whole address also catches what the parts hide: a bare "?" or "#" at the end.
  if (url.href !== `${url.origin}/`) {
    throw new Error(`LAGER_PUBLIC_URL must be only the address of the platform, without a path, query or user name, ${example} (it is "${raw}")`);
  }
  return url;
}

const HOST_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The apps domain: a bare host name. Nothing is cut off silently, because a value that was meant differently would serve no instance. */
function parseAppsDomain(raw: string): string {
  const domain = raw.toLowerCase();
  if (domain.length > 253 || !HOST_NAME_RE.test(domain)) {
    throw new Error(`LAGER_APPS_DOMAIN must be a host name only, for example apps.example.com: no "https://", no "*.", no port and no "/" (it is "${raw}")`);
  }
  return domain;
}

/** Checked at start, so a mistyped address does not surface as a failed mail days later. */
function parseSmtpUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const hint = 'LAGER_SMTP_URL must look like smtp://user:password@smtp.example.com:587 or smtps://user:password@smtp.example.com:465';
  // The value is not echoed: it usually contains the mail password.
  let url: URL | null = null;
  try { url = new URL(value); } catch { /* refused below */ }
  // A path is what remains of a password with an unencoded "/"; the host would then be a piece of the password.
  // The same goes for "#", which would cut the address off in the middle of the user name or password.
  if (!url || (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || !url.hostname || url.pathname.length > 1 || value.includes('#')) {
    throw new Error(`${hint}; special characters in the user name and password must be percent-encoded ("@" becomes "%40", "#" becomes "%23")`);
  }
  return value;
}

function parseBoolEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  throw new Error(`${name} must be true or false`);
}

/** `false`/`0` → no proxy, `true`/empty → one hop, a positive integer → that many hops. */
function parseTrustProxy(raw: string | undefined): number | false {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'true') return 1;
  if (v === 'false' || v === '0') return false;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error('LAGER_TRUST_PROXY must be true, false or a positive integer');
  return n;
}

function parseLocale(raw: string | undefined): Locale {
  const v = raw?.trim().toLowerCase();
  if (!v) return 'en';
  if (!isLocale(v)) throw new Error(`LAGER_DEFAULT_LOCALE must be one of ${LOCALES.join(', ')}`);
  return v;
}

/** Example values shipped in .env.example and earlier releases; acceptable only where the public URL is this machine itself. */
export const ADMIN_PASSWORD_PLACEHOLDERS: readonly string[] = ['change-me-please', 'change-me', 'bitte-aendern'];

/** Shortest LAGER_SECRET accepted from the environment; the generated one has 64 characters. */
export const MIN_SECRET_LENGTH = 32;

/**
 * True for a public URL host that names this machine itself: localhost, *.localhost and the loopback addresses, with or without the
 * trailing dot of a fully qualified name. It says where visitors are sent, not who can connect: the port may still be published
 * on every interface (the Docker quick start does that).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const publicUrl = parsePublicUrl(required(env, 'LAGER_PUBLIC_URL'));
  const appsDomain = parseAppsDomain(required(env, 'LAGER_APPS_DOMAIN'));
  // Everything is checked before the data directory is touched, so a refused configuration leaves nothing behind.
  // 0 lets the system pick a free port; the start line says which one.
  const port = parseIntEnv(env, 'LAGER_PORT', 8080, 0, 65535);
  const quotaMb = parseIntEnv(env, 'LAGER_INSTANCE_QUOTA_MB', 50, 1);
  let snapshotKeep = parseIntEnv(env, 'LAGER_SNAPSHOT_KEEP', 20);
  if (snapshotKeep === 0) {
    // Earlier releases accepted 0 and kept one snapshot; an installation with that value keeps starting.
    console.warn('WARNING: LAGER_SNAPSHOT_KEEP is 0, but one snapshot is always kept: Lager uses 1. Set 1 or more.');
    snapshotKeep = 1;
  }
  const trashDays = parseIntEnv(env, 'LAGER_TRASH_DAYS', 30);
  const aiTimeoutSeconds = parseIntEnv(env, 'LAGER_AI_TIMEOUT_SECONDS', 90, 5, 600);
  const accessLog = parseBoolEnv(env, 'LAGER_ACCESS_LOG');
  const trustProxy = parseTrustProxy(env.LAGER_TRUST_PROXY);
  const defaultLocale = parseLocale(env.LAGER_DEFAULT_LOCALE);
  const smtpUrl = parseSmtpUrl(env.LAGER_SMTP_URL);
  const dataDir = path.resolve(env.LAGER_DATA_DIR?.trim() || './data');
  fs.mkdirSync(dataDir, { recursive: true });
  const envSecret = env.LAGER_SECRET?.trim() || undefined;
  return {
    dataDir,
    port,
    host: env.LAGER_HOST?.trim() || undefined,
    accessLog,
    publicUrl,
    appsDomain,
    adminEmail: env.LAGER_ADMIN_EMAIL?.trim() || undefined,
    adminPassword: env.LAGER_ADMIN_PASSWORD || undefined,
    secret: envSecret ?? loadSecret(dataDir),
    weakSecret: envSecret !== undefined && envSecret.length < MIN_SECRET_LENGTH,
    snapshotKeep,
    trustProxy,
    smtpUrl,
    mailFrom: env.LAGER_MAIL_FROM?.trim() || `Lager <no-reply@${publicUrl.hostname}>`,
    instanceQuotaBytes: quotaMb * 1024 * 1024,
    defaultLocale,
    trashDays,
    aiTimeoutSeconds,
  };
}

/** Public URL of an instance: same protocol and port as publicUrl, host `<slug>.<appsDomain>`. */
export function instanceUrl(cfg: Config, slug: string): string {
  const port = cfg.publicUrl.port ? `:${cfg.publicUrl.port}` : '';
  return `${cfg.publicUrl.protocol}//${slug}.${cfg.appsDomain}${port}`;
}

/** URL of an arbitrary host (a custom domain): same protocol and port as publicUrl. */
export function hostUrl(cfg: Config, host: string): string {
  const port = cfg.publicUrl.port ? `:${cfg.publicUrl.port}` : '';
  return `${cfg.publicUrl.protocol}//${host}${port}`;
}
