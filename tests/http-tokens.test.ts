import { afterEach, describe, expect, it, vi } from 'vitest';
import { openToken, sealToken, signToken, verifyToken } from '../src/http/tokens.js';

const s = 'secret';
afterEach(() => { vi.useRealTimers(); });

describe('tokens', () => {
  it('roundtrips', () => {
    const t = signToken({ uid: 'u1', k: 'inst' }, s, 60);
    expect(verifyToken<{ uid: string; k: string }>(t, s)).toMatchObject({ uid: 'u1', k: 'inst' });
  });
  it('rejects wrong secret', () => {
    expect(verifyToken(signToken({ uid: 'u1' }, s, 60), 'other')).toBeNull();
  });
  it('rejects tampered payload', () => {
    const [, sig] = signToken({ uid: 'u1' }, s, 60).split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    expect(verifyToken(forged + '.' + sig, s)).toBeNull();
  });
  it('rejects expired', () => {
    vi.useFakeTimers();
    const t = signToken({ uid: 'u1' }, s, 60);
    vi.advanceTimersByTime(59_000);
    expect(verifyToken(t, s)).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(verifyToken(t, s)).toBeNull();
  });
  it('rejects garbage', () => {
    for (const t of [undefined, '', 'a', 'a.b', 'a.b.c']) expect(verifyToken(t, s)).toBeNull();
  });
});

describe('sealed tokens', () => {
  it('roundtrip, and the payload cannot be read from the token', () => {
    const t = sealToken({ uid: 'u1', p: { name: 'jonas@example.com' } }, s, 60);
    expect(openToken<{ uid: string; p: { name: string } }>(t, s)).toMatchObject({ uid: 'u1', p: { name: 'jonas@example.com' } });
    expect(Buffer.from(t, 'base64url').toString('latin1')).not.toContain('jonas');
    // Two seals of the same payload differ (a fresh nonce each time).
    expect(sealToken({ uid: 'u1' }, s, 60)).not.toBe(sealToken({ uid: 'u1' }, s, 60));
  });
  it('reject another secret, a changed byte, a signed token, expiry and garbage', () => {
    const t = sealToken({ uid: 'u1' }, s, 60);
    expect(openToken(t, 'other')).toBeNull();
    const raw = Buffer.from(t, 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(openToken(raw.toString('base64url'), s)).toBeNull();
    expect(openToken(signToken({ uid: 'u1' }, s, 60), s)).toBeNull();
    vi.useFakeTimers();
    const soon = sealToken({ uid: 'u1' }, s, 60);
    vi.advanceTimersByTime(61_000);
    expect(openToken(soon, s)).toBeNull();
    for (const g of [undefined, '', 'a', 'A'.repeat(40), 'a.b']) expect(openToken(g, s)).toBeNull();
  });
});
