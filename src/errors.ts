export type ErrorCode = 'not_found' | 'forbidden' | 'invalid_argument' | 'conflict' | 'unauthenticated' | 'quota_exceeded';

export class LagerError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = 'LagerError';
  }
}
