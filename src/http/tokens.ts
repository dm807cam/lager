import crypto from 'node:crypto';

function sign(body: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(body).digest();
}

/**
 * What lets a request fetch the icon of an instance that is not public without the instance cookie: browsers and phones fetch
 * home-screen icons on their own, often without cookies. Lager writes it into the icon addresses of the page and the manifest
 * it serves to a viewer with access. It is bound to the instance and to the icon's version and does not expire: an installed
 * app keeps its icon address for as long as that icon exists. It opens nothing but the icon.
 */
export function iconToken(instanceId: string, iconVersion: number, secret: string): string {
  return sign(`icon\n${instanceId}\n${iconVersion}`, secret).toString('base64url');
}

export function iconTokenValid(value: unknown, instanceId: string, iconVersion: number, secret: string): boolean {
  if (typeof value !== 'string') return false;
  const expected = Buffer.from(iconToken(instanceId, iconVersion, secret));
  const actual = Buffer.from(value);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** HMAC-SHA256 signed token `<base64url payload>.<base64url signature>`; `exp` (epoch seconds) is added to the payload. */
export function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

/** Returns the payload, or null for a bad signature, expiry or malformed input. Callers must check their own `k` kind. */
export function verifyToken<T>(token: string | undefined, secret: string): T | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = sign(parts[0], secret);
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000)) return null;
    return payload as T;
  } catch {
    return null;
  }
}

/** The AES-256 key of sealed tokens, derived from the secret so that it never doubles as an HMAC key. */
const sealKey = (secret: string): Buffer => crypto.createHmac('sha256', secret).update('lager sealed token v1').digest();

/**
 * Like `signToken`, but the payload is also unreadable: AES-256-GCM, `<base64url iv | tag | ciphertext>`. For values that end up
 * in a URL (browser history, proxy logs) and carry what only their recipient should read, such as the names in a notice.
 */
export function sealToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(secret), iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Returns the payload of a sealed token, or null when it was not sealed with this secret, was changed, expired or is malformed. */
export function openToken<T>(token: string | undefined, secret: string): T | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(secret), raw.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000)) return null;
    return payload as T;
  } catch {
    return null;
  }
}
