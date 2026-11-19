import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { RateLimiter } from './ratelimit.js';

/** Restores and manual version changes per instance and hour: each one writes a full copy of the instance's documents. */
export const SNAPSHOT_ACTIONS_PER_HOUR = 10;

const limiters = new WeakMap<Core, RateLimiter>();

/**
 * Counts one restore or manual activation of the instance and throws `rate_limited` once the hour's budget is used up.
 * The dashboard, the REST API and the MCP tools share the one budget of a server.
 */
export function countSnapshotAction(core: Core, instanceId: string): void {
  let limiter = limiters.get(core);
  if (!limiter) limiters.set(core, limiter = new RateLimiter(SNAPSHOT_ACTIONS_PER_HOUR, 60 * 60_000));
  if (!limiter.hit(instanceId)) {
    throw new LagerError('rate_limited', 'Too many restores and version changes on this instance in the last hour; try again later.', 'snapshot_rate');
  }
}
