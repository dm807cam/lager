// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const RUNTIME = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/runtime.js'), 'utf8');
const NOTES = fs.readFileSync(path.resolve(process.cwd(), 'examples/notes.html'), 'utf8');

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

class QuietEventSource {
  constructor(public url: string) {}
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => { delete g.claude; delete g.storage; document.body.innerHTML = ''; });

describe('examples/notes.html with the real runtime', () => {
  it('shows the viewer name, not a function', async () => {
    g.fetch = async (url: string): Promise<Response> => {
      if (url === '/__lager/session') {
        return json({
          viewer: { id: 'u1', name: 'Ada Lovelace', email: null, level: 'owner', isOwner: true, canEdit: true },
          instance: { id: 'i1', slug: 'notes', appSlug: 'notes', version: 1 }, capabilities: { db: {}, user: {} }, loginUrl: '/login',
        });
      }
      if (url === '/__lager/db') return json({ docs: [] });
      return json({ error: { code: 'not_found', message: 'x' } });
    };
    g.EventSource = QuietEventSource;
    (0, eval)(RUNTIME);
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(NOTES.replace(/<script>[\s\S]*<\/script>/, ''))![1];
    const script = /<script>([\s\S]*)<\/script>/.exec(NOTES)![1];
    (0, eval)(script);
    const who = document.getElementById('who')!;
    for (let i = 0; i < 50 && !who.textContent; i++) await new Promise((r) => setTimeout(r, 5));
    expect(who.textContent).toBe('Angemeldet als Ada Lovelace');
    expect(who.textContent).not.toContain('function');
  });
});
