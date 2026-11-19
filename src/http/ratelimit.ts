/**
 * Fixed-budget sliding-window counter keyed by an arbitrary string (client IP, e-mail address, …).
 * Expired entries are swept on every hit and the number of tracked keys is capped, so memory stays bounded.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private max: number, private windowMs: number, private maxKeys = 10_000) {}

  /** Records an attempt; returns false (and records nothing) when the key already used up its budget (`max`, else the one given at construction). */
  hit(key: string, max = this.max): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [k, list] of this.hits) {
      if (list[list.length - 1] <= cutoff) this.hits.delete(k);
    }
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.delete(key);
    // Still full of live keys: drop the oldest ones so the map cannot grow without bound.
    while (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    this.hits.set(key, list);
    return true;
  }

  /** True when the key has used up its budget; records nothing. */
  full(key: string, max = this.max): boolean {
    const cutoff = Date.now() - this.windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > cutoff).length >= max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /**
   * Takes back the newest attempt of the key. For work that is awaited: `hit` first, so that requests arriving together cannot all
   * pass a check made before any of them was counted, and `release` when the attempt turns out not to count.
   */
  release(key: string): void {
    const list = this.hits.get(key);
    if (!list) return;
    list.pop();
    if (list.length === 0) this.hits.delete(key);
  }
}
