export type ErrorCode = 'not_found' | 'forbidden' | 'invalid_argument' | 'conflict' | 'unauthenticated' | 'quota_exceeded';

export class LagerError extends Error {
  /** `reason` is a stable machine code (for example `slug_retired`) that pages map to localized notices; the message is English and never matched. */
  constructor(public code: ErrorCode, message: string, public reason?: string) {
    super(message);
    this.name = 'LagerError';
  }
}
