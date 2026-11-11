import type { Response } from 'express';
import { LagerError, type ErrorCode } from '../errors.js';

const STATUS: Record<ErrorCode, number> = {
  not_found: 404, forbidden: 403, invalid_argument: 400, conflict: 409, unauthenticated: 401,
};

export function sendError(res: Response, err: unknown, extra?: Record<string, unknown>): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof LagerError) {
    res.status(STATUS[err.code]).json({ error: { code: err.code, message: err.message, ...extra } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error.' } });
}

/** Only local absolute paths are allowed as redirect targets; anything else becomes '/'. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\r\n\t]/.test(value)) return '/';
  return value;
}
