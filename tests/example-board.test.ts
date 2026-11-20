// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const RUNTIME = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/runtime.js'), 'utf8');
const BOARD = fs.readFileSync(path.resolve(process.cwd(), 'examples/board.html'), 'utf8');

const BLOB = '/_blob/' + 'a'.repeat(32);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Records every stream the runtime opens so a test can play the server's part. */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(name: string, fn: (e: { data: string }) => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  close(): void {}
  send(name: string, data: unknown): void { for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) }); }
}

function boot(capabilities: Record<string, unknown>, calls: Array<{ url: string; init?: RequestInit }> = [], signedOut = false): void {
  FakeEventSource.all = [];
  g.fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url === '/__lager/session') {
      if (signedOut) return json({ error: { code: 'unauthenticated', message: 'Sign in required.' }, loginUrl: '/login' }, 401);
      return json({
        viewer: { id: 'u1', name: 'Ada Lovelace', email: null, level: 'owner', isOwner: true, canEdit: true },
        instance: { id: 'i1', slug: 'board', appSlug: 'board', version: 1 }, capabilities, loginUrl: '/login',
      });
    }
    if (url === '/__lager/db') {
      const op = JSON.parse(String(init?.body)).op;
      if (op === 'query') return json({ docs: [{ path: 'cards/c1', data: { text: 'Milch kaufen', image: BLOB, createdAt: 1 }, createdAt: '', updatedAt: '', createdBy: 'u1' }] });
      // The server makes up the id of an added document.
      if (op === 'add') return json({ doc: {}, id: 'serverMadeId000000001' });
      return json({ doc: {} });
    }
    if (url === '/__lager/assets' && init?.method === 'POST') return json({ id: 'a'.repeat(32), url: BLOB, sizeBytes: 3, contentType: 'image/png' }, 201);
    return json({ error: { code: 'not_found', message: 'x' } }, 404);
  };
  g.EventSource = FakeEventSource;
  delete g.__lagerRuntime;
  (0, eval)(RUNTIME);
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(BOARD.replace(/<script>[\s\S]*<\/script>/, ''))![1];
  (0, eval)(/<script>([\s\S]*)<\/script>/.exec(BOARD)![1]);
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};
const $ = (id: string): HTMLElement => document.getElementById(id)!;

afterEach(() => { delete g.lager; document.body.innerHTML = ''; });

describe('examples/board.html with the real runtime', () => {
  it('uses no external resources and no browser storage', () => {
    expect(BOARD).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
    expect(BOARD).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    expect(BOARD).toContain('prefers-color-scheme: dark');
    expect(BOARD).toContain('width=device-width');
  });

  it('renders cards, the viewer, presence and offers upload and export when every namespace is present', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    boot({ db: {}, user: {}, assets: {}, room: {}, downloads: {} }, calls);
    await until(() => $('who').textContent === 'Signed in as Ada Lovelace');
    await until(() => $('cards').children.length === 1);
    expect($('cards').textContent).toContain('Milch kaufen');
    expect(($('cards').querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(BLOB);
    expect($('file').hidden).toBe(false);
    expect($('export').hidden).toBe(false);
    expect($('nodb').hidden).toBe(true);

    // The server's part: the hello of the lobby carries the peer list; the page shows the names.
    await until(() => FakeEventSource.all.some((s) => s.url.startsWith('/__lager/room/events')));
    const lobby = FakeEventSource.all.find((s) => s.url.startsWith('/__lager/room/events'))!;
    lobby.send('hello', { peer: 'p1', peers: [{ peer: 'p1', by: 'u1', guest: false, presence: {} }, { peer: 'p2', by: 'u2', guest: false, presence: { name: 'Grace' } }] });
    await until(() => $('here').textContent === 'Here now: Ada Lovelace (you), Grace');
    expect($('here').hidden).toBe(false);

    // Pinning a card with a picture uploads the file first and stores the returned url.
    ($('text') as HTMLInputElement).value = 'Neue Karte';
    Object.defineProperty($('file'), 'files', { value: [new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })] });
    ($('add') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => calls.some((c) => c.url === '/__lager/db' && JSON.parse(String(c.init?.body)).op === 'add'));
    const add = calls.map((c) => c.init?.body).filter((b) => typeof b === 'string').map((b) => JSON.parse(b as string)).find((b) => b.op === 'add' && b.path === 'cards');
    expect(add.data).toMatchObject({ text: 'Neue Karte', image: BLOB });
    expect(calls.some((c) => c.url === '/__lager/assets' && c.init?.method === 'POST')).toBe(true);
  });

  it('still renders when assets and room are null', async () => {
    boot({ db: {}, user: {}, downloads: {} });
    await until(() => $('cards').children.length === 1);
    expect($('file').hidden).toBe(true);
    expect($('here').hidden).toBe(true);
    expect(FakeEventSource.all.some((s) => s.url.startsWith('/__lager/room/events'))).toBe(false);
    expect($('export').hidden).toBe(false);
    expect($('status').textContent).toBe('');
  });

  it('shows a notice and hides the form without a database', async () => {
    boot({}, [], true);
    await until(() => !$('nodb').hidden);
    expect($('add').hidden).toBe(true);
    expect($('cards').children.length).toBe(0);
  });
});
