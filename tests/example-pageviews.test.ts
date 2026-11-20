// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkApp } from '../src/platform/check.js';
import { parseIngest } from '../src/platform/ingest.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const RUNTIME = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/runtime.js'), 'utf8');
const PAGE = fs.readFileSync(path.resolve(process.cwd(), 'examples/pageviews.html'), 'utf8');
/** The capabilities the example names in its own comment: the test deploys exactly what the file tells people to deploy. */
const CAPS = JSON.parse(/\n\s*(\{"db"[\s\S]*?\})\n\n/.exec(PAGE)![1]) as Record<string, unknown>;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class QuietEventSource {
  constructor(public url: string) {}
  addEventListener(): void {}
  close(): void {}
}

const ENDPOINT = { name: 'hits', path: '/_ingest/hits', collection: 'hits', auth: 'none', origins: ['https://blog.example.com'], maxBytes: 1024, enabled: true, token: null };
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;
/** What the website sent, newest first; one sender tried to slip markup in. */
const HITS = [
  { path: '/hello', ref: 'news.example', _receivedAt: ago(1000), _visitor: 'v1', _country: 'DE' },
  { path: '/hello', ref: '', _receivedAt: ago(2000), _visitor: 'v1', _country: 'DE' },
  { path: '<img src=x onerror="window.pwned=1">', ref: '<b>bold</b>', _receivedAt: ago(3000), _visitor: 'v2', _country: 'FR' },
  { path: '/old', ref: 'news.example', _receivedAt: ago(3 * 24 * HOUR), _visitor: 'v3' },
  { path: '/ancient', _receivedAt: ago(9 * 24 * HOUR), _visitor: 'v4' },
  { path: 7, ref: { nested: true }, _receivedAt: 'not a date' },
];

function boot(opts: { capabilities?: Record<string, unknown>; level?: string; endpoint?: Record<string, unknown> | null } = {}): Array<{ url: string; body?: any }> {
  const calls: Array<{ url: string; body?: any }> = [];
  const level = opts.level ?? 'owner';
  g.fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url === '/__lager/session') {
      return json({
        viewer: { id: 'u1', name: 'Ada', email: null, level, isOwner: level === 'owner', canEdit: level === 'owner' || level === 'admin' },
        instance: { id: 'i1', slug: 'pageviews', appSlug: 'pageviews', version: 1 }, capabilities: opts.capabilities ?? CAPS, loginUrl: '/login',
      });
    }
    if (url === '/__lager/ingest') return json({ endpoints: opts.endpoint === null ? [] : [{ ...ENDPOINT, ...opts.endpoint }] });
    if (url === '/__lager/db') return json({ docs: HITS.map((data, i) => ({ path: `hits/h${i}`, id: `h${i}`, data, version: 1, createdAt: '', updatedAt: '', updatedBy: null })) });
    return json({ error: { code: 'not_found', message: 'x' } }, 404);
  };
  g.EventSource = QuietEventSource;
  delete g.__lagerRuntime;
  delete g.pwned;
  (0, eval)(RUNTIME);
  // The file is read the way a browser reads it: parsed as HTML, its one script taken out of the body and run after it.
  const parsed = new DOMParser().parseFromString(PAGE, 'text/html');
  const script = parsed.body.querySelector('script')!;
  script.remove();
  document.body.innerHTML = parsed.body.innerHTML;
  (0, eval)(script.textContent!);
  return calls;
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};
const $ = (id: string): HTMLElement => document.getElementById(id)!;

afterEach(() => { delete g.lager; document.body.innerHTML = ''; });

describe('examples/pageviews.html with the real runtime', () => {
  it('declares what it uses, loads nothing from elsewhere and keeps nothing in the browser', () => {
    expect(parseIngest(CAPS.ingest).map((e) => e.name)).toEqual(['hits']);
    const check = checkApp(PAGE, CAPS);
    expect(check).toMatchObject({ used: ['db', 'ingest', 'user'], unsupported: [], undeclared: [] });
    // The one warning is the one every app with an open endpoint gets.
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]).toMatch(/^Anyone can add data through the endpoint "hits"/);
    expect(PAGE).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
    expect(PAGE).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(PAGE).toContain('width=device-width');
  });

  it('shows the owner the numbers of the last seven days and the snippet for the website', async () => {
    const calls = boot();
    await until(() => !$('numbers').hidden);
    expect($('today').textContent).toBe('3');
    expect($('visitors').textContent).toBe('2');
    expect($('week').textContent).toBe('4');
    expect($('pages').textContent).toContain('/hello2');
    expect($('pages').textContent).toContain('/old1');
    expect($('pages').textContent).not.toContain('/ancient');
    expect($('referrers').textContent).toContain('news.example2');
    expect($('countries').textContent).toBe('DE2FR1');
    expect($('status').textContent).toBe('');
    // The newest thousand, by the time the server wrote.
    expect(calls.find((c) => c.url === '/__lager/db')!.body).toEqual({ op: 'query', path: 'hits', query: { orderBy: [['_receivedAt', 'desc']], limit: 1000 } });
    expect($('setup').hidden).toBe(false);
    expect($('origins').textContent).toBe('https://blog.example.com');
    expect($('snippet').textContent).toContain(`var url = "${window.location.origin}/_ingest/hits";`);
    expect($('snippet').textContent).toContain('navigator.sendBeacon');
    expect($('off').hidden).toBe(true);
  });

  it('shows what a website sent as text, never as markup', async () => {
    boot();
    await until(() => !$('numbers').hidden);
    expect($('pages').querySelector('img')).toBeNull();
    expect($('referrers').querySelector('b')).toBeNull();
    expect($('pages').textContent).toContain('<img src=x onerror="window.pwned=1">');
    expect(g.pwned).toBeUndefined();
  });

  it('says so when the endpoint is switched off', async () => {
    boot({ endpoint: { enabled: false } });
    await until(() => !$('setup').hidden);
    expect($('off').hidden).toBe(false);
  });

  it('keeps the numbers from people who do not manage the instance, and asks for nothing', async () => {
    const calls = boot({ level: 'interact' });
    await until(() => $('status').textContent !== '');
    expect($('status').textContent).toBe('Only the people who manage this instance see its numbers.');
    expect($('numbers').hidden).toBe(true);
    expect($('setup').hidden).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['/__lager/session']);
  });

  it('explains itself when it was deployed without the ingest capability', async () => {
    boot({ capabilities: { db: {}, user: {} } });
    await until(() => $('status').textContent !== '');
    expect($('status').textContent).toMatch(/deploy the app with the db and ingest capabilities/);
    expect($('numbers').hidden).toBe(true);
  });
});
