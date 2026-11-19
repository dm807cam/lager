import crypto from 'node:crypto';

function sign(body: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(body).digest();
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
