/**
 * The storage one instance may use (documents, uploaded files and self-saved pages together), in bytes; 0 = unlimited.
 * Either one size for every instance or a lookup per instance (see `Quotas` in the platform).
 */
export type Quota = number | ((instanceId: string) => number);

/** The size of `quota` for one instance. */
export const quotaFor = (quota: Quota, instanceId: string): number => (typeof quota === 'number' ? quota : quota(instanceId));
