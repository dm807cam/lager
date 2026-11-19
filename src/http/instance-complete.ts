import express from 'express';
import type { Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { AiError, HOURLY_LIMIT_MAX, isTruncated, type ChatMessage } from '../platform/ai.js';
import type { Ctx } from './instance.js';
import { RateLimiter } from './ratelimit.js';

const BODY_LIMIT = '1mb';
const MAX_MESSAGES = 200;
/** Characters across all messages; roughly 100k tokens, far more than a page should need to send. */
const MAX_CHARS = 400_000;
const MAX_IN_FLIGHT_PER_USER = 3;
const WINDOW_MS = 3600_000;
const ROLES = ['system', 'user', 'assistant'];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

type Failure = { status: number; code: string; message: string };

function reply(res: Response, f: Failure): void {
  res.status(f.status).set('Cache-Control', 'no-store').json({ error: { code: f.code, message: f.message } });
}

/** Turns the page's argument into chat messages: a prompt string, or a list of `{role, content}`. */
export function toMessages(input: unknown, system: unknown): ChatMessage[] {
  let messages: ChatMessage[];
  if (typeof input === 'string') {
    if (input === '') throw new LagerError('invalid_argument', 'The prompt is empty.');
    messages = [{ role: 'user', content: input }];
  } else if (Array.isArray(input)) {
    if (input.length === 0 || input.length > MAX_MESSAGES) throw new LagerError('invalid_argument', `Send from 1 to ${MAX_MESSAGES} messages.`);
    messages = input.map((m) => {
      if (!isObject(m) || typeof m.role !== 'string' || !ROLES.includes(m.role) || typeof m.content !== 'string') throw new LagerError('invalid_argument', 'Every message needs a role (user, assistant or system) and a string content.');
      return { role: (m as { role: ChatMessage['role'] }).role, content: (m as { content: string }).content };
    });
    if (!messages.some((m) => m.role === 'user')) throw new LagerError('invalid_argument', 'At least one message must come from the user.');
  } else {
    throw new LagerError('invalid_argument', 'messages must be a string or a list of messages.');
  }
  if (system !== undefined) {
    if (typeof system !== 'string') throw new LagerError('invalid_argument', 'system must be a string.');
    if (system) messages = [{ role: 'system', content: system as string }, ...messages];
  }
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) throw new LagerError('invalid_argument', 'The conversation is too long.');
  return messages;
}

/** The catalog model the app asks for: the owner's choice, else what the active version declares in `complete.model`. */
export function wantedModel(core: Core, ctx: Ctx): string | null {
  const chosen = core.apps.getApp(ctx.instance.appId)?.aiModelId;
  if (chosen) return chosen;
  const declared = isObject(ctx.caps.complete) ? ctx.caps.complete.model : undefined;
  return typeof declared === 'string' && declared ? declared : null;
}

/**
 * Mounts `POST /__lager/complete`: the page's `window.lager.complete` asks the model the app wants when the caller's
 * AI group allows it, and otherwise the default model of the caller's group.
 * Only signed-in viewers with at least `interact` may call it, so guests on public apps cannot spend the server's credit.
 */
export function mountCompleteRoutes(router: express.Router, core: Core, ctxOf: (res: Response) => Ctx, requireAccess: (ctx: Ctx) => void): void {
  // One window per person; each request is checked against the limit of the person's AI group at that moment.
  const limiter = new RateLimiter(HOURLY_LIMIT_MAX, WINDOW_MS);
  const inFlight = new Map<string, number>();

  router.post('/__lager/complete', express.json({ limit: BODY_LIMIT }), async (req, res, next) => {
    try {
      if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
      const ctx = ctxOf(res);
      requireAccess(ctx);
      if (!isObject(ctx.caps.complete)) { reply(res, { status: 403, code: 'not_declared', message: 'This app does not use a language model.' }); return; }
      const userId = ctx.viewer.userId;
      if (userId === null) throw new LagerError('unauthenticated', 'Sign in to use the language model.');
      const level = ctx.viewer.level;
      if (level !== 'interact' && level !== 'admin' && level !== 'owner') throw new LagerError('forbidden', 'You may only view this app.');
      const route = core.ai.routeFor(userId, wantedModel(core, ctx));
      if (!route) { reply(res, { status: 503, code: 'not_configured', message: 'No language model is available to you.' }); return; }
      const body: unknown = req.body;
      if (!isObject(body)) throw new LagerError('invalid_argument', 'Request body must be a JSON object.');
      const messages = toMessages(body.messages, body.system);
      const maxTokens = body.maxTokens;
      if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1)) throw new LagerError('invalid_argument', 'maxTokens must be a positive whole number.');
      const running = inFlight.get(userId) ?? 0;
      if (running >= MAX_IN_FLIGHT_PER_USER || !limiter.hit(userId, route.hourlyLimit)) {
        res.set('Retry-After', running >= MAX_IN_FLIGHT_PER_USER ? '5' : '60');
        reply(res, { status: 429, code: 'rate_limited', message: 'Too many requests to the language model; try again later.' });
        return;
      }
      inFlight.set(userId, running + 1);
      // A page that goes away stops waiting; the provider call is cancelled with it.
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      try {
        const out = await core.ai.complete(route, messages, { maxTokens: maxTokens as number | undefined, signal: abort.signal });
        res.set('Cache-Control', 'no-store').json({ text: out.text, model: out.model, stopReason: out.stopReason, truncated: isTruncated(out.stopReason) });
      } finally {
        const n = (inFlight.get(userId) ?? 1) - 1;
        if (n > 0) inFlight.set(userId, n); else inFlight.delete(userId);
      }
    } catch (e) {
      if (e instanceof AiError) {
        if (e.detail) console.error(`lager: language model call failed: ${e.message} ${e.detail}`);
        if (!res.headersSent) reply(res, { status: e.status, code: e.reason, message: e.message });
        return;
      }
      next(e);
    }
  });
}
