/**
 * Fixed-budget sliding-window counter keyed by an arbitrary string (client IP, e-mail address, …).
 * Expired entries are swept on every hit and the number of tracked keys is capped, so memory stays bounded.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private max: number, private windowMs: number, private maxKeys = 10_000) {}

  /** Records an attempt; returns false (and records nothing) when the key already used up its budget. */
  hit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [k, list] of this.hits) {
      if (list[list.length - 1] <= cutoff) this.hits.delete(k);
    }
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.max) {
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

  reset(key: string): void {
    this.hits.delete(key);
  }
}
