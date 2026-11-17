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
}

/** Longest instance name (a DNS label). */
export const MAX_SLUG_LENGTH = 63;
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** App and instance ids are UUIDs; a slug of that shape would be ambiguous wherever a slug or an id is accepted. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESERVED_SLUGS = new Set(['www', 'api', 'lager', 'admin', 'mcp', 'auth', 'static']);

export function assertSlug(slug: string): void {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new LagerError('invalid_argument', `Invalid slug "${slug}": use lowercase letters, digits and hyphens (max ${MAX_SLUG_LENGTH} characters).`, 'slug_invalid');
  }
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

function parseIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
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

/** Example values shipped in .env.example and earlier releases; never acceptable on a public https instance. */
export const ADMIN_PASSWORD_PLACEHOLDERS: readonly string[] = ['change-me', 'bitte-aendern'];

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const publicUrl = new URL(required(env, 'LAGER_PUBLIC_URL'));
  const appsDomain = required(env, 'LAGER_APPS_DOMAIN').toLowerCase();
  const dataDir = path.resolve(env.LAGER_DATA_DIR?.trim() || './data');
  fs.mkdirSync(dataDir, { recursive: true });
  const quotaMb = parseIntEnv(env, 'LAGER_INSTANCE_QUOTA_MB', 50);
  if (quotaMb < 1) throw new Error('LAGER_INSTANCE_QUOTA_MB must be a positive integer');
  return {
    dataDir,
    port: parseIntEnv(env, 'LAGER_PORT', 8080),
    host: env.LAGER_HOST?.trim() || undefined,
    accessLog: parseBoolEnv(env, 'LAGER_ACCESS_LOG'),
    publicUrl,
    appsDomain,
    adminEmail: env.LAGER_ADMIN_EMAIL?.trim() || undefined,
    adminPassword: env.LAGER_ADMIN_PASSWORD || undefined,
    secret: env.LAGER_SECRET?.trim() || loadSecret(dataDir),
    snapshotKeep: parseIntEnv(env, 'LAGER_SNAPSHOT_KEEP', 20),
    trustProxy: parseTrustProxy(env.LAGER_TRUST_PROXY),
    smtpUrl: env.LAGER_SMTP_URL?.trim() || undefined,
    mailFrom: env.LAGER_MAIL_FROM?.trim() || `Lager <no-reply@${publicUrl.hostname}>`,
    instanceQuotaBytes: quotaMb * 1024 * 1024,
    defaultLocale: parseLocale(env.LAGER_DEFAULT_LOCALE),
    trashDays: parseIntEnv(env, 'LAGER_TRASH_DAYS', 30),
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
