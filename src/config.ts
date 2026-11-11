import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LagerError } from './errors.js';

export interface Config {
  dataDir: string;
  port: number;
  publicUrl: URL;
  appsDomain: string;
  adminEmail?: string;
  adminPassword?: string;
  secret: string;
  snapshotKeep: number;
  trustProxy: boolean;
}

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(['www', 'api', 'lager', 'admin', 'mcp', 'auth', 'static']);

export function assertSlug(slug: string): void {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new LagerError('invalid_argument', `Invalid slug "${slug}": use lowercase letters, digits and hyphens (max 63 characters).`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new LagerError('invalid_argument', `Slug "${slug}" is reserved.`);
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const publicUrl = new URL(required(env, 'LAGER_PUBLIC_URL'));
  const appsDomain = required(env, 'LAGER_APPS_DOMAIN').toLowerCase();
  const dataDir = path.resolve(env.LAGER_DATA_DIR?.trim() || './data');
  fs.mkdirSync(dataDir, { recursive: true });
  const defaultPort = publicUrl.port ? Number(publicUrl.port) : publicUrl.protocol === 'https:' ? 443 : 80;
  const trust = env.LAGER_TRUST_PROXY?.trim().toLowerCase();
  return {
    dataDir,
    port: parseIntEnv(env, 'LAGER_PORT', defaultPort),
    publicUrl,
    appsDomain,
    adminEmail: env.LAGER_ADMIN_EMAIL?.trim() || undefined,
    adminPassword: env.LAGER_ADMIN_PASSWORD || undefined,
    secret: loadSecret(dataDir),
    snapshotKeep: parseIntEnv(env, 'LAGER_SNAPSHOT_KEEP', 20),
    trustProxy: !(trust === 'false' || trust === '0'),
  };
}

/** Public URL of an instance: same protocol and port as publicUrl, host `<slug>.<appsDomain>`. */
export function instanceUrl(cfg: Config, slug: string): string {
  const port = cfg.publicUrl.port ? `:${cfg.publicUrl.port}` : '';
  return `${cfg.publicUrl.protocol}//${slug}.${cfg.appsDomain}${port}`;
}
