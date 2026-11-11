import type { Request, Response } from 'express';
import { LagerError, type ErrorCode } from '../errors.js';

const STATUS: Record<ErrorCode, number> = {
  not_found: 404, forbidden: 403, invalid_argument: 400, conflict: 409, unauthenticated: 401, quota_exceeded: 507,
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

/**
 * After an answer that was decided without reading the body: the rest of the upload is read and thrown away, so the client
 * still receives the answer instead of a reset. A client that keeps sending is cut off after ten seconds.
 */
export function discardBody(req: Request): void {
  if (req.readableEnded) return;
  req.resume();
  const cutoff = setTimeout(() => { if (!req.readableEnded) req.destroy(); }, 10_000);
  cutoff.unref();
  req.once('end', () => clearTimeout(cutoff));
  req.once('close', () => clearTimeout(cutoff));
}
