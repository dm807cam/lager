import { afterEach, describe, expect, it, vi } from 'vitest';
import { signToken, verifyToken } from '../src/http/tokens.js';

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
