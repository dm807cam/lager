export type HubEvent = { type: 'change'; path: string; parent: string } | { type: 'reset' } | { type: 'reload'; version: number };

/** In-process pub/sub of data events, keyed by instance id. */
export class Hub {
  private subs = new Map<string, Set<(e: HubEvent) => void>>();

  publish(instanceId: string, e: HubEvent): void {
    for (const fn of [...(this.subs.get(instanceId) ?? [])]) {
      try {
        fn(e);
      } catch {
        // a failing subscriber must never break a write
      }
    }
  }

  subscribe(instanceId: string, fn: (e: HubEvent) => void): () => void {
    let set = this.subs.get(instanceId);
    if (!set) this.subs.set(instanceId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0 && this.subs.get(instanceId) === set) this.subs.delete(instanceId);
    };
  }
}
