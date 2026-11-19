// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The guide's complete example is what an AI copies when it has never seen Lager before, whichever model it is.
 * This runs that exact HTML against the real browser runtime, so the example cannot drift away from the API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const RUNTIME = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/runtime.js'), 'utf8');
const GUIDE = fs.readFileSync(path.resolve(process.cwd(), 'src/guide.md'), 'utf8');
const API_SECTION = GUIDE.slice(GUIDE.indexOf('## Runtime API'), GUIDE.indexOf('## Database access rules'));
const EXAMPLE = /```html\n([\s\S]*?)```/.exec(API_SECTION)![1];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class QuietEventSource {
  constructor(public url: string) {}
  addEventListener(): void {}
  close(): void {}
}

interface Op { op: string; path: string; data?: Record<string, unknown> }

function mountRuntime(handler: (op: Op) => Response): Op[] {
  const ops: Op[] = [];
  g.fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/__lager/session') {
      return json({
        viewer: { id: 'u1', name: 'Ada Lovelace', email: null, level: 'interact', isOwner: false, canEdit: true },
        instance: { id: 'i1', slug: 'list', appSlug: 'list', version: 1 }, capabilities: { db: {}, user: {} }, loginUrl: '/login',
      });
    }
    if (url === '/__lager/db') {
      const op = JSON.parse(String(init?.body)) as Op;
      ops.push(op);
      return handler(op);
    }
    return json({ error: { code: 'not_found', message: 'x' } }, 404);
  };
  g.EventSource = QuietEventSource;
  delete g.__lagerRuntime;
  (0, eval)(RUNTIME);
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(EXAMPLE.replace(/<script>[\s\S]*<\/script>/, ''))![1];
  (0, eval)(/<script>([\s\S]*)<\/script>/.exec(EXAMPLE)![1]);
  return ops;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => { delete g.claude; delete g.storage; document.body.innerHTML = ''; });

describe('the complete example in the guide', () => {
  it('is a whole HTML document that declares nothing the runtime lacks', () => {
    expect(EXAMPLE.startsWith('<!doctype html>')).toBe(true);
    expect(EXAMPLE).toContain('claude.use("db")');
    expect(EXAMPLE).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('lists the stored items and adds one with the viewer name', async () => {
    const stored = [{ id: 'a', data: { text: 'Milk', by: 'Grace', createdAt: 1 }, version: 1, updatedAt: '2026-01-01T00:00:00Z' }];
    const ops = mountRuntime((op) => (op.op === 'query' ? json({ docs: stored }) : json({ doc: { id: 'x', data: op.data, version: 1 } })));
    await until(() => document.querySelectorAll('#items li').length === 1);
    expect(document.querySelector('#items li')!.textContent).toContain('Milk (Grace)');

    (document.getElementById('text') as HTMLInputElement).value = 'Bread';
    document.getElementById('add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => ops.some((o) => o.op === 'set'));
    const write = ops.find((o) => o.op === 'set')!;
    expect(write.path).toMatch(/^items\/[^/]+$/);
    expect(write.data).toMatchObject({ text: 'Bread', by: 'Ada Lovelace' });
    expect(typeof write.data!.createdAt).toBe('number');
  });

  it('explains a refused write instead of breaking', async () => {
    const ops = mountRuntime((op) => (op.op === 'query' ? json({ docs: [] }) : json({ error: { code: 'forbidden', message: 'Not allowed.' } }, 403)));
    // The form handler is attached once the page has its database and has started listening.
    await until(() => ops.some((o) => o.op === 'query'));
    await new Promise((r) => setTimeout(r, 10));
    (document.getElementById('text') as HTMLInputElement).value = 'Bread';
    document.getElementById('add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const status = document.getElementById('status')!;
    await until(() => status.textContent !== '');
    expect(status.textContent).toBe('You can only read this list.');
  });
});
