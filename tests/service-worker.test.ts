import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SOURCE = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/sw.js'), 'utf8');
const ORIGIN = 'https://todo.apps.example.org';
const CDN = 'https://cdn.example.net/lib@1.2.3/lib.min.js';
const MARK = { 'X-Lager-Offline': '1' };

/** What a response from another host without CORS looks like to a worker: no status, no headers, no body to read. */
const opaque = (): any => ({ type: 'opaque', status: 0, ok: false, redirected: false, headers: new Headers(), clone() { return this; } });
/** A navigation fetched with `redirect: "manual"` that the server answered with a redirect (here: to the sign-in). */
const opaqueRedirect = (): any => ({ type: 'opaqueredirect', status: 0, ok: false, redirected: false, headers: new Headers(), clone() { return this; } });
const page = (body: string, headers: Record<string, string> = MARK, status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'text/html', ...headers } });
const SESSION = {
  viewer: { id: 'u1', name: 'Ada', email: 'ada@example.org', level: 'owner', isOwner: true, canEdit: true, locale: 'en' },
  instance: { id: 'i1', slug: 'todo', appSlug: 'todo', version: 3 }, capabilities: { db: {} }, loginUrl: 'https://lager.example.org/auth/instance?slug=todo&n=abc',
};
const sessionBody = (headers: Record<string, string> = MARK, status = 200): Response => {
  const text = JSON.stringify(SESSION);
  return new Response(text, { status, headers: { 'Content-Type': 'application/json', 'Content-Length': String(text.length), ...headers } });
};
/** A file on a host that sends no CORS headers: a request in CORS mode fails, one without gets an opaque answer. */
const noCors = () => (_url: string, mode: string): any => (mode === 'cors' ? 'offline' : opaque());
/** A file on a host that allows CORS (as jsdelivr, unpkg and cdnjs do). */
const withCors = (body = 'x()') => (): Response => new Response(body, { headers: { 'Access-Control-Allow-Origin': '*' } });
const script = (body = 'x()'): Response => new Response(body, { headers: { 'Content-Type': 'text/javascript' } });

/** Cache Storage in memory: named caches of URL -> response, keys kept in the order they were stored. */
class FakeCaches {
  stores = new Map<string, Map<string, any>>();
  private abs = (k: string | { url: string }): string => new URL(typeof k === 'string' ? k : k.url, ORIGIN).href;
  async open(name: string): Promise<any> {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const store = this.stores.get(name)!;
    return {
      match: async (k: any) => { const r = store.get(this.abs(k)); return r ? r.clone() : undefined; },
      put: async (k: any, r: any) => { const key = this.abs(k); store.delete(key); store.set(key, r); },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (k: any) => store.delete(this.abs(k)),
    };
  }
  async keys(): Promise<string[]> { return [...this.stores.keys()]; }
  async delete(name: string): Promise<boolean> { return this.stores.delete(name); }
  /** The URLs kept in the worker's cache, relative to the instance where they belong to it. */
  kept(): string[] {
    return [...(this.stores.get('lager-offline-1')?.keys() ?? [])].map((u) => {
      const url = new URL(u);
      return url.origin === ORIGIN ? url.pathname + url.search : u;
    });
  }
  async body(url: string): Promise<string | null> {
    const r = this.stores.get('lager-offline-1')?.get(new URL(url, ORIGIN).href);
    return r ? r.clone().text() : null;
  }
}

type Reply = Response | any | Promise<Response | any> | 'offline' | 'hang';
let caches: FakeCaches;
/** A route is a reply, or a function of the URL and the request mode that returns one. */
let routes: Map<string, Reply | ((url: string, mode: string) => Reply)>;
let fetched: { url: string; init?: any; request?: any }[];
let listeners: Map<string, (e: any) => void>;
let claimed: number;
let skipped: number;

function fakeFetch(input: any, init?: any): Promise<any> {
  const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;
  fetched.push({ url, init, request: typeof input === 'string' ? undefined : input });
  const route = routes.get(url);
  const mode = (typeof input === 'string' ? init?.mode : input.mode) ?? 'cors';
  const reply = typeof route === 'function' ? route(url, mode) : route;
  if (reply === undefined || reply === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
  if (reply === 'hang') return new Promise(() => {});
  return Promise.resolve(reply);
}

function boot(): void {
  listeners = new Map();
  const self: any = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
    skipWaiting: () => { skipped++; return Promise.resolve(); },
    clients: {
      claim: async () => { claimed++; },
      get: async (id: string) => (id === 'top' ? { frameType: 'top-level' } : id === 'frame' ? { frameType: 'nested' } : undefined),
    },
  };
  vm.runInNewContext(SOURCE, {
    self, caches, fetch: fakeFetch, Headers, Response, URL, Promise,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (t: any) => clearTimeout(t),
  });
}

/** Dispatches a fetch event; `response` is what the worker answered (undefined when it let the browser handle the request). */
/**
 * Dispatches a fetch event; `response` is what the worker answered (undefined when it let the browser handle the request).
 * By default the request comes from the top-level page, and a navigation loads that page (`destination: "document"`).
 */
async function dispatch(url: string, opts: { method?: string; mode?: string; destination?: string; clientId?: string } = {}): Promise<{ response: Promise<any> | undefined; settled: () => Promise<void> }> {
  const waits: Promise<unknown>[] = [];
  let response: Promise<any> | undefined;
  const destination = opts.destination ?? (opts.mode === 'navigate' ? 'document' : '');
  // The page is served with `Referrer-Policy: same-origin`, and its requests carry that policy.
  const request = { url: new URL(url, ORIGIN).href, method: opts.method ?? 'GET', mode: opts.mode ?? 'cors', destination, referrerPolicy: 'same-origin' };
  const event = {
    request, clientId: opts.clientId ?? (opts.mode === 'navigate' ? '' : 'top'),
    respondWith: (p: Promise<any>) => { response = p; }, waitUntil: (p: Promise<unknown>) => { waits.push(p); },
  };
  listeners.get('fetch')!(event);
  // Work the worker starts once it knows who asked (the session) is registered a moment later.
  return { response, settled: async () => { if (response) await response.catch(() => {}); await Promise.all(waits); } };
}

const navigate = (url = '/'): ReturnType<typeof dispatch> => dispatch(url, { mode: 'navigate' });

/** Answers a request the way the browser would see it, and waits until the worker has stored what it keeps. */
async function load(url: string, opts: Parameters<typeof dispatch>[1] = {}): Promise<any> {
  const ev = await dispatch(url, opts);
  expect(ev.response, `${url} is answered by the worker`).toBeDefined();
  const res = await ev.response;
  await ev.settled();
  return res;
}

const at = (p: string): string => new URL(p, ORIGIN).href;

beforeEach(() => {
  caches = new FakeCaches();
  routes = new Map();
  fetched = [];
  claimed = 0;
  skipped = 0;
  boot();
});
afterEach(() => { vi.useRealTimers(); });

describe('service worker: the page', () => {
  it('keeps a page the server marks and serves it, marked as kept, when the network fails', async () => {
    routes.set(at('/'), page('<p>v1</p>'));
    const online = await load('/', { mode: 'navigate' });
    expect(await online.text()).toBe('<p>v1</p>');
    expect(online.headers.get('X-Lager-From-Cache')).toBeNull();
    expect(caches.kept()).toEqual(['/']);

    routes.set(at('/'), 'offline');
    const offline = await load('/', { mode: 'navigate' });
    expect(await offline.text()).toBe('<p>v1</p>');
    expect(offline.headers.get('X-Lager-From-Cache')).toBe('1');
    expect(offline.headers.get('Content-Type')).toBe('text/html');
    // /index.html and a query string are the same page.
    expect(await (await load('/index.html?tab=2', { mode: 'navigate' })).text()).toBe('<p>v1</p>');
  });

  it('a newer page replaces the kept one', async () => {
    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    routes.set(at('/'), page('<p>v2</p>'));
    await load('/', { mode: 'navigate' });
    expect(await caches.body('/')).toBe('<p>v2</p>');
  });

  it('keeps nothing without the mark, and an unmarked page deletes what was kept (the app turned offline off)', async () => {
    routes.set(at('/'), page('<p>v1</p>', {}));
    await load('/', { mode: 'navigate' });
    expect(caches.kept()).toEqual([]);

    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    routes.set(at('/__lager/runtime.js'), script());
    await load('/__lager/runtime.js');
    expect(caches.kept()).toEqual(['/', '/__lager/runtime.js']);
    routes.set(at('/'), page('<p>v2</p>', {}));
    expect(await (await load('/', { mode: 'navigate' })).text()).toBe('<p>v2</p>');
    expect(await caches.keys()).toEqual([]);
  });

  it('a redirect to the sign-in, 401, 403, 404 and 410 delete everything kept', async () => {
    for (const gone of [opaqueRedirect, () => page('no', {}, 401), () => page('no', {}, 403), () => page('no', {}, 404), () => page('no', {}, 410)]) {
      routes.set(at('/'), page('<p>v1</p>'));
      await load('/', { mode: 'navigate' });
      routes.set(at('/__lager/session'), sessionBody());
      await load('/__lager/session');
      expect(caches.kept()).toEqual(['/', '/__lager/session']);
      const answer = gone();
      routes.set(at('/'), answer);
      // The browser gets the server's answer, never the kept page.
      expect(await load('/', { mode: 'navigate' })).toBe(answer);
      expect(await caches.keys()).toEqual([]);
    }
  });

  it('a server that is down (502, 503, 504) is answered with the kept page; other errors go through', async () => {
    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    for (const status of [502, 503, 504]) {
      routes.set(at('/'), page('Bad gateway', {}, status));
      const res = await load('/', { mode: 'navigate' });
      expect(await res.text()).toBe('<p>v1</p>');
      expect(res.headers.get('X-Lager-From-Cache')).toBe('1');
    }
    routes.set(at('/'), page('Busy', {}, 429));
    expect((await load('/', { mode: 'navigate' })).status).toBe(429);
    expect(caches.kept()).toEqual(['/']);
  });

  it('without a kept page, failures reach the browser unchanged', async () => {
    routes.set(at('/'), page('Bad gateway', {}, 502));
    expect((await load('/', { mode: 'navigate' })).status).toBe(502);
    routes.set(at('/'), 'offline');
    const ev = await navigate();
    await expect(ev.response).rejects.toThrow(/Failed to fetch/);
  });

  it('a network that does not answer in time is answered with the kept page; the late answer is still kept', async () => {
    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    routes.set(at('/'), new Promise<Response>((r) => { release = r; }));
    const ev = await navigate();
    let answered: any = null;
    void ev.response!.then((r) => { answered = r; });
    await vi.advanceTimersByTimeAsync(3999);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await answered.text()).toBe('<p>v1</p>');
    release(page('<p>v2</p>'));
    await ev.settled();
    expect(await caches.body('/')).toBe('<p>v2</p>');
  });

  it('without a kept page a slow network is waited for', async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    routes.set(at('/'), new Promise<Response>((r) => { release = r; }));
    const ev = await navigate();
    let answered: any = null;
    void ev.response!.then((r) => { answered = r; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(answered).toBeNull();
    release(page('<p>v1</p>'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await answered.text()).toBe('<p>v1</p>');
  });
});

describe('service worker: session, scripts and files from other hosts', () => {
  it('keeps the marked session and answers with it offline, without the email address and the sign-in link', async () => {
    routes.set(at('/__lager/session'), sessionBody());
    const online = await load('/__lager/session');
    // The page itself gets the whole answer.
    expect((await online.json()).viewer.email).toBe('ada@example.org');
    const kept = JSON.parse((await caches.body('/__lager/session'))!);
    expect(kept.viewer).toEqual({ ...SESSION.viewer, email: null });
    expect(kept).not.toHaveProperty('loginUrl');
    expect(kept.instance).toEqual(SESSION.instance);
    expect(kept.capabilities).toEqual(SESSION.capabilities);
    routes.set(at('/__lager/session'), 'offline');
    const res = await load('/__lager/session');
    expect(res.headers.get('X-Lager-From-Cache')).toBe('1');
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Content-Length')).toBeNull();
    const body = await res.json();
    expect(body.viewer.id).toBe('u1');
    expect(body.viewer.name).toBe('Ada');
    expect(body.viewer.email).toBeNull();
    // Signed out meanwhile: the next answer online deletes it.
    routes.set(at('/__lager/session'), sessionBody({}, 401));
    expect((await load('/__lager/session')).status).toBe(401);
    expect(caches.kept()).toEqual([]);
  });

  it('a session that is refused deletes the kept page as well', async () => {
    for (const status of [401, 403]) {
      routes.set(at('/'), page('<p>v1</p>'));
      await load('/', { mode: 'navigate' });
      routes.set(at('/__lager/session'), sessionBody());
      await load('/__lager/session');
      routes.set(at('/__lager/runtime.js'), script());
      await load('/__lager/runtime.js');
      expect(caches.kept()).toHaveLength(3);
      routes.set(at('/__lager/session'), sessionBody({}, status));
      await load('/__lager/session');
      expect(await caches.keys()).toEqual([]);
    }
  });

  it('keeps nothing of an answer that is not a session', async () => {
    routes.set(at('/__lager/session'), new Response('not json', { headers: MARK }));
    expect(await (await load('/__lager/session')).text()).toBe('not json');
    routes.set(at('/__lager/session'), new Response('{"viewer":null}', { headers: MARK }));
    await load('/__lager/session');
    expect(caches.kept()).toEqual([]);
  });

  it('frames get neither a kept page nor a kept session, and do not replace them', async () => {
    routes.set(at('/'), page('<p>top</p>'));
    await load('/', { mode: 'navigate' });
    routes.set(at('/__lager/session'), sessionBody());
    await load('/__lager/session');

    // The instance inside a frame of itself, or a request whose client cannot be told: straight to the network.
    expect((await dispatch('/', { mode: 'navigate', destination: 'iframe' })).response).toBeUndefined();
    routes.set(at('/__lager/session'), () => new Response(JSON.stringify({ viewer: { id: null, level: 'view' } }), { headers: MARK }));
    for (const clientId of ['frame', 'unknown', '']) {
      const framed = await load('/__lager/session', { clientId });
      expect((await framed.json()).viewer.id).toBeNull();
    }
    expect(JSON.parse((await caches.body('/__lager/session'))!).viewer.id).toBe('u1');

    routes.set(at('/__lager/session'), 'offline');
    await expect((await dispatch('/__lager/session', { clientId: 'frame' })).response).rejects.toThrow(/Failed to fetch/);
    expect((await (await load('/__lager/session')).json()).viewer.id).toBe('u1');
  });

  it('keeps the runtime, manifest and icons only while a page is kept', async () => {
    routes.set(at('/__lager/runtime.js'), script('runtime'));
    await load('/__lager/runtime.js');
    expect(caches.kept()).toEqual([]);

    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    routes.set(at('/__lager/runtime.js'), script('runtime'));
    routes.set(at('/__lager/manifest.webmanifest'), new Response('{}'));
    routes.set(at('/__lager/icon-192.png?v=3&t=abc'), new Response('png'));
    await load('/__lager/runtime.js');
    await load('/__lager/manifest.webmanifest');
    await load('/__lager/icon-192.png?v=3&t=abc');
    expect(caches.kept()).toEqual(['/', '/__lager/runtime.js', '/__lager/manifest.webmanifest', '/__lager/icon-192.png?v=3&t=abc']);

    routes.set(at('/__lager/runtime.js'), 'offline');
    expect(await (await load('/__lager/runtime.js')).text()).toBe('runtime');
    // A failed answer is not kept over the good one.
    routes.set(at('/__lager/runtime.js'), new Response('oops', { status: 500 }));
    expect((await load('/__lager/runtime.js')).status).toBe(500);
    expect(await caches.body('/__lager/runtime.js')).toBe('runtime');
  });

  it('keeps scripts, styles and fonts from other hosts, and gives an opaque copy only to a request without CORS', async () => {
    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    routes.set(CDN, noCors());
    await load(CDN, { mode: 'no-cors', destination: 'script' });
    expect(caches.kept()).toEqual(['/', CDN]);

    routes.set(CDN, 'offline');
    expect((await load(CDN, { mode: 'no-cors', destination: 'script' })).type).toBe('opaque');
    const cors = await dispatch(CDN, { mode: 'cors', destination: 'script' });
    await expect(cors.response).rejects.toThrow(/Failed to fetch/);

    // A tag with `crossorigin` makes a CORS request, and its copy is not opaque.
    const font = 'https://fonts.example.net/a.woff2';
    routes.set(font, withCors('font'));
    await load(font, { mode: 'cors', destination: 'font' });
    routes.set(font, 'offline');
    const kept = await load(font, { mode: 'cors', destination: 'font' });
    expect(kept.type).not.toBe('opaque');
    expect(await kept.text()).toBe('font');
  });

  it('passes a request to another host on exactly as the page made it, so the CDN learns no more than without the worker', async () => {
    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    for (const mode of ['no-cors', 'cors']) {
      fetched = [];
      routes.set(CDN, mode === 'cors' ? withCors() : noCors());
      await load(CDN, { mode, destination: 'script' });
      // One request, the page's own Request object, with its mode and referrer policy: no new request with an Origin or a Referer.
      expect(fetched).toHaveLength(1);
      expect(fetched[0].init).toBeUndefined();
      expect(fetched[0].request).toMatchObject({ url: CDN, mode, referrerPolicy: 'same-origin' });
    }
  });

  it('keeps at most 40 files from other hosts, of which at most 10 opaque ones, the newest of each', async () => {
    routes.set(at('/'), page('<p>v1</p>'));
    await load('/', { mode: 'navigate' });
    for (let i = 0; i < 15; i++) {
      const url = `https://cdn.example.net/o${i}.js`;
      routes.set(url, noCors());
      await load(url, { mode: 'no-cors', destination: 'script' });
    }
    let foreign = caches.kept().filter((u) => !u.startsWith('/'));
    expect(foreign).toEqual(Array.from({ length: 10 }, (_, i) => `https://cdn.example.net/o${i + 5}.js`));

    for (let i = 0; i < 45; i++) {
      const url = `https://cdn.example.net/c${i}.js`;
      routes.set(url, withCors());
      await load(url, { mode: 'cors', destination: 'script' });
    }
    foreign = caches.kept().filter((u) => !u.startsWith('/'));
    expect(foreign).toHaveLength(40);
    // The opaque copies count towards the 40 as well; the oldest files go first.
    expect(foreign.filter((u) => u.includes('/o'))).toEqual([]);
    expect(foreign[0]).toBe('https://cdn.example.net/c5.js');
    expect(caches.kept()).toContain('/');
  });

  it('leaves everything else to the browser', async () => {
    for (const [url, opts] of [
      ['/__lager/db', { method: 'POST' }],
      ['/__lager/db/events', {}],
      ['/__lager/room/events', {}],
      ['/__lager/users?ids=u1', {}],
      ['/__lager/callback?code=x', { mode: 'navigate' }],
      ['/_blob/' + 'a'.repeat(32), { destination: 'image' }],
      ['/__lager/sw.js', {}],
      ['/', { method: 'POST', mode: 'navigate' }],
      ['/', {}],
      ['https://cdn.example.net/photo.jpg', { mode: 'no-cors', destination: 'image' }],
      ['https://api.example.net/data', {}],
    ] as const) {
      expect((await dispatch(url, opts)).response, url).toBeUndefined();
    }
    expect(fetched).toEqual([]);
  });
});

describe('service worker: install and activate', () => {
  const HTML = `<!doctype html><html><head>
<script src="${CDN}"></script>
<script type="module" src='https://cdn.example.net/mod.js'></script>
<script src=https://cdn.example.net/anon.js crossorigin></script>
<link rel="stylesheet" href="https://cdn.example.net/style.css" crossorigin="use-credentials">
<link rel="icon" href="https://cdn.example.net/icon.png">
<script src="/local.js"></script>
<script src="/__lager/runtime.js"></script>
</head><body></body></html>`;

  async function install(): Promise<void> {
    const waits: Promise<unknown>[] = [];
    listeners.get('install')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }

  it('fetches the page, the session, the runtime and the files from other hosts the page names', async () => {
    routes.set(at('/'), page(HTML));
    routes.set(at('/__lager/session'), sessionBody());
    routes.set(at('/__lager/runtime.js'), script());
    routes.set(CDN, noCors());
    routes.set('https://cdn.example.net/mod.js', withCors());
    routes.set('https://cdn.example.net/anon.js', withCors());
    routes.set('https://cdn.example.net/style.css', withCors());
    await install();
    expect(skipped).toBe(1);
    expect(caches.kept().sort()).toEqual(['/', '/__lager/runtime.js', '/__lager/session', CDN,
      'https://cdn.example.net/anon.js', 'https://cdn.example.net/mod.js', 'https://cdn.example.net/style.css'].sort());
    const inits = (u: string): any[] => fetched.filter((f) => f.url === u).map((f) => f.init);
    expect(inits(at('/'))).toEqual([{ credentials: 'same-origin', redirect: 'manual' }]);
    // The mode the page's tag asks for, so the kept copy answers the browser's request, and the page's referrer policy.
    expect(inits(CDN)).toEqual([{ mode: 'no-cors', credentials: 'omit', referrerPolicy: 'same-origin' }]);
    expect(inits('https://cdn.example.net/mod.js')).toEqual([{ mode: 'cors', credentials: 'omit', referrerPolicy: 'same-origin' }]);
    expect(inits('https://cdn.example.net/anon.js')).toEqual([{ mode: 'cors', credentials: 'omit', referrerPolicy: 'same-origin' }]);
    expect(inits('https://cdn.example.net/style.css')).toEqual([{ mode: 'cors', credentials: 'include', referrerPolicy: 'same-origin' }]);
    expect(JSON.parse((await caches.body('/__lager/session'))!).viewer.email).toBeNull();
    expect(fetched.map((f) => f.url)).not.toContain('https://cdn.example.net/icon.png');
    expect(fetched.map((f) => f.url)).not.toContain(at('/local.js'));
  });

  it('fetches nothing more when the page is not marked or the viewer is sent to the sign-in', async () => {
    for (const answer of [page(HTML, {}), opaqueRedirect()]) {
      fetched = [];
      routes.set(at('/'), answer);
      await install();
      expect(fetched.map((f) => f.url)).toEqual([at('/')]);
      expect(caches.kept()).toEqual([]);
    }
  });

  it('installs without a connection', async () => {
    await install();
    expect(caches.kept()).toEqual([]);
  });

  it('activating deletes caches of earlier workers, keeps others, and takes over open pages', async () => {
    await caches.open('lager-offline-0');
    await caches.open('lager-offline-1');
    await caches.open('something-else');
    const waits: Promise<unknown>[] = [];
    listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect((await caches.keys()).sort()).toEqual(['lager-offline-1', 'something-else']);
    expect(claimed).toBe(1);
  });
});
