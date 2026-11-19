import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { DB_RATE } from '../src/http/instance.js';
import { makeHarness, type Harness } from './support/http.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const RUNTIME = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/runtime.js'), 'utf8');
const HOST = 'todo.apps.localhost';

class QuietEventSource {
  constructor(public url: string) {}
  addEventListener(): void {}
  close(): void {}
}

let h: Harness | undefined;
let dom: JSDOM | undefined;
afterEach(() => { vi.useRealTimers(); dom?.window.close(); dom = undefined; h?.core.close(); h = undefined; });

const until = async (done: () => boolean, ms: number): Promise<void> => {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe('the real runtime against a rate-limited server', () => {
  it('a live listener survives the 429, waits as told and delivers again once the budget is back', async () => {
    h = makeHarness();
    const inst = h.core.apps.deploy({ slug: 'todo', html: '<p>1</p>', userId: h.adminId, capabilities: { db: {} } }).instances[0];
    h.core.data.set(inst.id, 'tasks/t1', { v: 1 }, h.adminId);
    const cookie = await h.enter('todo', await h.login());
    const answers: Array<{ status: number; at: number }> = [];
    // The page runs in a browser window of its own; its fetch is answered by the real instance routes.
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://${HOST}/`, runScripts: 'outside-only' });
    const win = dom.window as any;
    win.fetch = async (url: string, init: any = {}) => {
      const req = init.method === 'POST' ? request(h!.app).post(url) : request(h!.app).get(url);
      req.set('Host', HOST).set('Cookie', cookie);
      for (const [k, v] of Object.entries(init.headers ?? {})) req.set(k, v as string);
      const res = await (init.body === undefined ? req : req.send(init.body));
      if (url === '/__lager/db') answers.push({ status: res.status, at: performance.now() });
      return {
        ok: res.status >= 200 && res.status < 300, status: res.status,
        headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
        json: async () => JSON.parse(res.text),
      };
    };
    win.EventSource = QuietEventSource;
    win.eval(RUNTIME);
    const db = await win.lager.use('db');
    expect(db).not.toBeNull();

    // Someone used up this viewer's read budget (another tab, a loop in the app).
    await Promise.all(Array.from({ length: DB_RATE.reads }, () => db.doc('tasks/t1').get()));
    const failure = await db.doc('tasks/t1').get().catch((e: unknown) => e);
    expect({ ...failure }).toEqual({ code: 'unavailable', message: 'Too many database requests; try again shortly.' });
    answers.length = 0;

    const seen: unknown[] = [];
    const errors: unknown[] = [];
    db.collection('tasks').onSnapshot((s: any) => seen.push(s.docs.map((d: any) => ({ ...d.data() }))), (e: unknown) => errors.push(e));
    await until(() => answers.length === 1, 2000);
    expect(answers.map((a) => a.status)).toEqual([429]);
    // Only the server's clock is moved: its window has passed long before the listener tries again.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DB_RATE.windowMs);
    await until(() => seen.length === 1, 8000);
    expect(answers.map((a) => a.status)).toEqual([429, 200]);
    expect(seen).toEqual([[{ v: 1 }]]);
    expect(errors).toEqual([]);
    // Retry-After was 5 s: the listener did not use its ordinary backoff, which starts at 1 s.
    expect(answers[1].at - answers[0].at).toBeGreaterThanOrEqual(4900);
  }, 30_000);
});
