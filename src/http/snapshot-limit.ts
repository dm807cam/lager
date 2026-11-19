import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { RateLimiter } from './ratelimit.js';

/** Snapshots taken on demand per instance and hour (restore, manual version change, switching auto-update on): each one is a full copy of the instance's documents. */
export const SNAPSHOT_ACTIONS_PER_HOUR = 10;

const limiters = new WeakMap<Core, RateLimiter>();

/**
 * Runs a restore, a manual activation or an auto-update switch of the instance under the hourly snapshot budget, which the
 * dashboard, the REST API and the MCP tools share. It is refused with `rate_limited` while the budget is used up; otherwise
 * it counts only if it really took a snapshot. An attempt that fails validation, changes nothing or finds no data costs nothing,
 * so nobody can use up the budget with requests that are refused anyway.
 */
export function withSnapshotBudget<T>(core: Core, instanceId: string, action: () => T): T {
  let limiter = limiters.get(core);
  if (!limiter) limiters.set(core, limiter = new RateLimiter(SNAPSHOT_ACTIONS_PER_HOUR, 60 * 60_000));
  if (limiter.full(instanceId)) {
    throw new LagerError('rate_limited', 'Too many restores and version changes on this instance in the last hour; try again later.', 'snapshot_rate');
  }
  const newest = (): string | undefined => core.data.listSnapshots(instanceId)[0]?.id;
  const before = newest();
  try {
    return action();
  } finally {
    // Also when the action failed after its snapshot: the copy is on disk either way.
    if (newest() !== before) limiter.hit(instanceId);
  }
}
