import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { backfillIcons, deployWithIcon } from '../src/mcp/tools.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const HOST = 'todo.apps.localhost:8080';
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#336699"/><circle cx="256" cy="256" r="100" fill="#fff"/></svg>';
const PAGE = '<!doctype html><html><head><title>t</title></head><body>hi</body></html>';

async function setup(opts: { title?: string; html?: string; themeColor?: string; visibility?: 'private' | 'users' | 'public' } = {}): Promise<Harness> {
  h = makeHarness();
  const user = h.core.users.get(h.adminId)!;
  await deployWithIcon(h.core, user, {
    slug: 'todo', html: opts.html ?? PAGE, title: opts.title ?? 'Todo list for the whole family', iconSvg: ICON, description: 'A shared list.', themeColor: opts.themeColor ?? '#336699',
  });
  if (opts.visibility) h.core.apps.setVisibility(h.core.apps.getInstanceBySlug('todo')!.id, opts.visibility, h.adminId);
  return h;
}

function pngSize(b: Buffer): { w: number; h: number } {
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const get = (h: Harness, host: string, url: string) => request(h.app).get(url).set('Host', host).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('instance manifest and icons', () => {
  it('manifest of an instance carries name, colours and three icons', async () => {
    const h = await setup({ visibility: 'private' });
    const res = await request(h.app).get('/__lager/manifest.webmanifest').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const v = h.core.apps.getApp('todo')!.iconVersion;
    expect(res.body).toEqual({
      name: 'Todo list for the whole family', short_name: 'Todo list fo', description: 'A shared list.',
      start_url: '/', scope: '/', display: 'standalone', background_color: '#336699', theme_color: '#336699',
      icons: [
        { src: `/__lager/icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/__lager/icon-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/__lager/icon-512-maskable.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  it('is served without a session and also to cross-site fetches of the install machinery', async () => {
    const h = await setup({ visibility: 'private' });
    for (const url of ['/__lager/manifest.webmanifest', '/__lager/icon-192.png', '/apple-touch-icon.png', '/favicon.ico']) {
      const res = await request(h.app).get(url).set('Host', HOST).set('Sec-Fetch-Site', 'cross-site').set('Sec-Fetch-Mode', 'no-cors');
      expect(res.status, url).toBe(200);
    }
  });

  it('a disabled instance serves nothing', async () => {
    const h = await setup();
    h.core.apps.setInstanceDisabled(h.core.apps.getInstanceBySlug('todo')!.id, true);
    for (const url of ['/__lager/manifest.webmanifest', '/__lager/icon-192.png', '/apple-touch-icon.png', '/favicon.ico']) {
      expect((await request(h.app).get(url).set('Host', HOST)).status, url).toBe(404);
    }
  });

  it('an unknown instance answers 404', async () => {
    const h = await setup();
    expect((await request(h.app).get('/__lager/manifest.webmanifest').set('Host', 'nope.apps.localhost:8080')).status).toBe(404);
  });

  it('icon routes serve PNGs with the right sizes; unknown size → 404', async () => {
    const h = await setup();
    for (const [url, size] of [['/__lager/icon-180.png', 180], ['/__lager/icon-192.png', 192], ['/__lager/icon-512.png', 512], ['/__lager/icon-512-maskable.png', 512]] as const) {
      const res = await get(h, HOST, url);
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(pngSize(res.body as Buffer)).toEqual({ w: size, h: size });
    }
    for (const url of ['/__lager/icon-64.png', '/__lager/icon-100.png', '/__lager/icon-512-maskable.png.svg', '/__lager/icon-180-maskable.png']) {
      expect((await request(h.app).get(url).set('Host', HOST)).status, url).toBe(404);
    }
  });

  it('caches an icon for a year only under its current version', async () => {
    const h = await setup();
    const v = h.core.apps.getApp('todo')!.iconVersion;
    expect((await request(h.app).get(`/__lager/icon-192.png?v=${v}`).set('Host', HOST)).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(h.app).get('/__lager/icon-192.png?v=0').set('Host', HOST)).headers['cache-control']).toBe('no-cache');
    expect((await request(h.app).get('/__lager/icon-192.png').set('Host', HOST)).headers['cache-control']).toBe('no-cache');
  });

  it('apple-touch-icon and favicon resolve', async () => {
    const h = await setup();
    const touch = await get(h, HOST, '/apple-touch-icon.png');
    expect(touch.status).toBe(200);
    expect(pngSize(touch.body as Buffer)).toEqual({ w: 180, h: 180 });
    const fav = await get(h, HOST, '/favicon.ico');
    expect(fav.status).toBe(200);
    expect(fav.headers['content-type']).toBe('image/png');
    expect(pngSize(fav.body as Buffer)).toEqual({ w: 64, h: 64 });
  });

  it('serves on a custom domain as well', async () => {
    const h = await setup();
    h.core.domains.add(h.core.apps.getInstanceBySlug('todo')!, 'todo.example.org', h.core.users.get(h.adminId)!, true);
    expect((await request(h.app).get('/__lager/manifest.webmanifest').set('Host', 'todo.example.org')).status).toBe(200);
  });

  it('manifest and icons expose nothing but name, description, colours and icons', async () => {
    const h = await setup();
    const body = (await request(h.app).get('/__lager/manifest.webmanifest').set('Host', HOST)).body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['background_color', 'description', 'display', 'icons', 'name', 'scope', 'short_name', 'start_url', 'theme_color']);
    const text = JSON.stringify(body);
    const app = h.core.apps.getApp('todo')!;
    for (const secret of [app.id, app.ownerId, 'admin@x.y']) expect(text).not.toContain(secret);
    // Only a PNG ever leaves the server; the source SVG is not reachable under any name.
    for (const url of ['/__lager/icon.svg', '/__lager/icon-512.svg', '/icon.svg']) expect((await request(h.app).get(url).set('Host', HOST)).status, url).toBe(404);
  });

  it('an app without a drawn icon is served the bundled placeholder and nothing is queued', async () => {
    h = makeHarness();
    h.core.apps.deploy({ slug: 'todo', html: PAGE, userId: h.adminId });
    const app = h.core.apps.getApp('todo')!;
    expect(h.core.icons.has(app.id)).toBe(false);
    const jobs = h.core.icons.jobsStarted;
    for (const [url, size] of [['/__lager/icon-192.png', 192], ['/__lager/icon-180.png', 180], ['/__lager/icon-512.png', 512], ['/__lager/icon-512-maskable.png', 512], ['/apple-touch-icon.png', 180], ['/favicon.ico', 64]] as const) {
      const res = await get(h, HOST, url);
      expect(res.status, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-cache');
      expect(pngSize(res.body as Buffer)).toEqual({ w: size, h: size });
    }
    expect((await request(h.app).get('/__lager/manifest.webmanifest').set('Host', HOST)).status).toBe(200);
    const platform = await get(h, h.host, `/app-icons/${app.id}/${app.iconVersion}/192.png`);
    expect(platform.status).toBe(200);
    expect(platform.headers['cache-control']).toBe('public, max-age=300');
    expect(pngSize(platform.body as Buffer)).toEqual({ w: 192, h: 192 });
    // Many anonymous visitors at once: still no drawing, no new version.
    await Promise.all(Array.from({ length: 30 }, () => request(h!.app).get('/__lager/icon-192.png').set('Host', HOST)));
    expect(h.core.icons.jobsStarted).toBe(jobs);
    expect(h.core.icons.has(app.id)).toBe(false);
    expect(h.core.apps.getApp('todo')!.iconVersion).toBe(app.iconVersion);
  });

  it('the background backfill draws the missing icons one at a time and stops after three failures', async () => {
    h = makeHarness();
    for (const slug of ['a1', 'a2', 'a3', 'a4', 'a5']) h.core.apps.deploy({ slug, html: PAGE, userId: h.adminId });
    await backfillIcons(h.core);
    for (const slug of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      const app = h.core.apps.getApp(slug)!;
      expect(h.core.icons.has(app.id), slug).toBe(true);
      expect(app.iconVersion, slug).toBe(1);
    }
    const broken = makeHarness();
    try {
      for (const slug of ['b1', 'b2', 'b3', 'b4', 'b5']) broken.core.apps.deploy({ slug, html: PAGE, userId: broken.adminId });
      const spy = vi.spyOn(broken.core.icons, 'setDefault').mockRejectedValue(new Error('no'));
      const log = vi.fn();
      await backfillIcons(broken.core, log);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      broken.core.close();
    }
  });
});

describe('head injection on the page', () => {
  const sessionPage = async (h: Harness): Promise<string> => {
    const cookie = await h.login();
    const inst = await h.enter('todo', cookie);
    return (await request(h.app).get('/').set('Host', HOST).set('Cookie', inst)).text;
  };

  it('the page gets manifest, icon and theme tags injected exactly once', async () => {
    const h = await setup();
    const html = await sessionPage(h);
    const v = h.core.apps.getApp('todo')!.iconVersion;
    for (const tag of [
      '<link rel="manifest" href="/__lager/manifest.webmanifest">',
      `<link rel="apple-touch-icon" href="/__lager/icon-180.png?v=${v}">`,
      `<link rel="icon" type="image/png" href="/__lager/icon-192.png?v=${v}">`,
      '<meta name="theme-color" content="#336699">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-title" content="Todo list for the whole family">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<script src="/__lager/runtime.js"></script>',
    ]) expect(html.split(tag).length, tag).toBe(2);
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('rel="manifest"'));
    expect(html.indexOf('rel="manifest"')).toBeLessThan(html.indexOf('<title>'));
  });

  it('an artifact with its own manifest link is left alone', async () => {
    const h = await setup({ html: '<!doctype html><html><head><meta name="viewport" content="width=300"><link rel="manifest" href="/mine.json"></head><body>x</body></html>' });
    const html = await sessionPage(h);
    expect(html).not.toContain('/__lager/manifest.webmanifest');
    expect(html).not.toContain('apple-touch-icon');
    expect(html).not.toContain('theme-color');
    expect(html).toContain('<link rel="manifest" href="/mine.json">');
    expect(html.match(/name="viewport"/g)).toHaveLength(1);
    expect(html).toContain('<script src="/__lager/runtime.js"></script>');
  });

  it('an artifact with its own icon link keeps it', async () => {
    const h = await setup({ html: '<!doctype html><html><head><link rel="shortcut icon" href="/mine.ico"></head><body>x</body></html>' });
    const html = await sessionPage(h);
    expect(html).not.toContain('/__lager/icon-192.png');
    expect(html).toContain('rel="manifest"');
  });

  it('title and colour cannot inject markup', async () => {
    const h = await setup({ title: '"><script>alert(1)</script>' });
    h.core.apps.setAppMeta(h.core.apps.getApp('todo')!.id, { themeColor: '#123456' }, h.adminId);
    // A bad stored value (written around the API) falls back to the default colour.
    (h.core as unknown as { apps: { db: { prepare(s: string): { run(...a: unknown[]): void } } } }).apps.db
      .prepare('UPDATE apps SET theme_color = ? WHERE slug = ?').run('"><script>x</script>', 'todo');
    const html = await sessionPage(h);
    expect(html).toContain('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).not.toContain('"><script>alert(1)');
    expect(html).toContain('<meta name="theme-color" content="#1f2a5c">');
    expect(html).not.toContain('<script>x</script>');
    const manifest = (await request(h.app).get('/__lager/manifest.webmanifest').set('Host', HOST)).body as { theme_color: string; background_color: string };
    expect(manifest.theme_color).toBe('#1f2a5c');
    expect(manifest.background_color).toBe('#1f2a5c');
  });
});

describe('platform host', () => {
  it('serves app icons by app id and version and its own manifest', async () => {
    const h = await setup();
    const app = h.core.apps.getApp('todo')!;
    const base = `/app-icons/${app.id}/${app.iconVersion}`;
    for (const size of [64, 192, 512]) {
      const res = await get(h, h.host, `${base}/${size}.png`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(pngSize(res.body as Buffer)).toEqual({ w: size, h: size });
    }
    // Anonymous: no session is needed.
    expect((await request(h.app).get(`${base}/192.png`).set('Host', h.host)).status).toBe(200);
    const wrong = await request(h.app).get(`/app-icons/${app.id}/${app.iconVersion + 7}/192.png`).set('Host', h.host);
    expect(wrong.status).toBe(302);
    expect(wrong.headers.location).toBe(`${base}/192.png`);
    expect(wrong.headers['cache-control']).not.toMatch(/immutable/);
    const junk = await request(h.app).get(`/app-icons/${app.id}/abc/192.png`).set('Host', h.host);
    expect(junk.status).toBe(302);
    expect((await request(h.app).get(`${base}/100.png`).set('Host', h.host)).status).toBe(404);
    expect((await request(h.app).get(`${base}/180.png`).set('Host', h.host)).status).toBe(404);
    expect((await request(h.app).get(`/app-icons/00000000-0000-0000-0000-000000000000/1/192.png`).set('Host', h.host)).status).toBe(404);
    // The slug is not an id.
    expect((await request(h.app).get(`/app-icons/todo/${app.iconVersion}/192.png`).set('Host', h.host)).status).toBe(404);

    const manifest = await request(h.app).get('/manifest.webmanifest').set('Host', h.host);
    expect(manifest.status).toBe(200);
    expect(manifest.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(manifest.body).toMatchObject({ name: 'Lager', start_url: '/', display: 'standalone' });
    for (const icon of manifest.body.icons as Array<{ src: string; sizes: string }>) {
      const file = await get(h, h.host, icon.src);
      expect(file.status, icon.src).toBe(200);
      expect(pngSize(file.body as Buffer).w).toBe(parseInt(icon.sizes, 10));
    }
    for (const [url, size] of [['/icon-180.png', 180], ['/icon-192.png', 192], ['/icon-512.png', 512]] as const) {
      const res = await get(h, h.host, url);
      expect(res.status).toBe(200);
      expect(pngSize(res.body as Buffer)).toEqual({ w: size, h: size });
      expect(res.headers['cache-control']).toMatch(/max-age=/);
    }
  });

  it('the platform pages link the manifest, touch icon and theme colour', async () => {
    const h = await setup();
    const login = (await request(h.app).get('/login').set('Host', h.host)).text;
    expect(login).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(login).toContain('<link rel="apple-touch-icon" href="/icon-180.png">');
    expect(login).toContain('<meta name="theme-color" content="#1f2a5c">');
  });

  it('the three platform icons ship with the source and are plain files', () => {
    for (const size of [180, 192, 512]) {
      const file = new URL(`../assets/icon-${size}.png`, import.meta.url);
      expect(fs.statSync(file).mode & 0o777).toBe(0o644);
      expect(pngSize(fs.readFileSync(file))).toEqual({ w: size, h: size });
    }
  });
});
