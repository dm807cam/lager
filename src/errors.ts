export type ErrorCode = 'not_found' | 'forbidden' | 'invalid_argument' | 'conflict' | 'unauthenticated';

export class LagerError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = 'LagerError';
  }
}
