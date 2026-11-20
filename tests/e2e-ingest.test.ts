import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';
import { apiExtension } from '../src/http/api.js';
import { createHttpApp } from '../src/http/app.js';
import { authExtension } from '../src/http/auth.js';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
type Call = (host: string, method: string, url: string, opts?: { headers?: Record<string, string>; body?: string }) => Promise<Res>;

async function boot(): Promise<{ core: Core; call: Call }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-e2e-ingest-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.localhost:8080'), appsDomain: 'apps.localhost',
    adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 'e2e-secret', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
  };
  const core = createCore(config);
  const server = http.createServer(createHttpApp(core, [authExtension, apiExtension]));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup = () => { server.closeAllConnections(); server.close(); core.close(); };
  const port = (server.address() as AddressInfo).port;
  // A real socket and an explicit Host header: the host routing and the body handling are the server's own.
  const call: Call = (host, method, url, opts = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
  return { core, call };
}

const cookiePair = (res: Res, name: string): string => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(name + '='));
  if (!raw) throw new Error(`no ${name} cookie`);
  return raw.split(';')[0];
};

describe('end to end: a website counts its page views on a private instance', () => {
  it('deploy the example → the blog sends → the owner reads; nobody else gets in or out', async () => {
    const { core, call } = await boot();
    const platform = 'lager.localhost:8080';
    const site = 'pageviews.apps.localhost:8080';
    const { token } = core.tokens.create(core.users.list()[0].id, 'e2e');
    const html = fs.readFileSync(new URL('../examples/pageviews.html', import.meta.url), 'utf8');
    const capabilities = /\n\s*(\{"db"[\s\S]*?\})\n\n/.exec(html)![1];

    const deploy = await call(platform, 'PUT', `/api/apps/pageviews?title=Page%20views&capabilities=${encodeURIComponent(capabilities)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' }, body: html,
    });
    expect(deploy.status).toBe(200);
    expect(JSON.parse(deploy.body).warnings.join('\n')).toMatch(/Anyone can add data through the endpoint "hits"/);

    // The blog's page, in a visitor's browser: a beacon is text/plain and carries the origin.
    const beacon = (body: string, origin = 'https://blog.example.com'): Promise<Res> =>
      call(site, 'POST', '/_ingest/hits', { headers: { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': 'Browser/1.0' }, body });
    for (const p of ['/', '/about', '/']) {
      const res = await beacon(JSON.stringify({ path: p, ref: 'news.example' }));
      expect(res.status).toBe(202);
      expect(res.body).toBe('');
    }
    expect((await beacon(JSON.stringify({ path: '/' }), 'https://other.example')).status).toBe(403);
    expect((await beacon('x'.repeat(2000))).status).toBe(413);

    // The instance is private: a stranger gets no page and no data, and the endpoint itself gives nothing back.
    expect((await call(site, 'GET', '/')).status).toBe(302);
    expect((await call(site, 'POST', '/__lager/db', { headers: { 'Content-Type': 'application/json', 'X-Lager-Request': '1' }, body: JSON.stringify({ op: 'query', path: 'hits' }) })).status).toBe(401);
    expect((await call(site, 'GET', '/_ingest/hits', { headers: { Origin: 'https://blog.example.com' } })).status).toBe(405);

    // The owner signs in and opens the dashboard's query.
    const login = await call(platform, 'POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=admin%40x.y&password=admin-password-1' });
    const session = cookiePair(login, 'lager_session');
    const nonce = 'n'.repeat(22);
    const auth = await call(platform, 'GET', `/auth/instance?slug=pageviews&return=%2F&n=${nonce}`, { headers: { Cookie: session } });
    const back = new URL(auth.headers.location!);
    const inst = cookiePair(await call(back.host, 'GET', back.pathname + back.search, { headers: { Cookie: `lager_nonce=${nonce}` } }), 'lager_inst');
    const query = await call(site, 'POST', '/__lager/db', {
      headers: { Cookie: inst, 'Content-Type': 'application/json', 'X-Lager-Request': '1' },
      body: JSON.stringify({ op: 'query', path: 'hits', query: { orderBy: [['_receivedAt', 'desc']], limit: 1000 } }),
    });
    expect(query.status).toBe(200);
    const docs = JSON.parse(query.body).docs as Array<{ data: Record<string, unknown>; updatedBy: string | null }>;
    expect(docs.map((d) => d.data.path).sort()).toEqual(['/', '/', '/about']);
    for (const d of docs) {
      expect(Object.keys(d.data).sort()).toEqual(['_receivedAt', '_visitor', 'path', 'ref']);
      expect(d.updatedBy).toBeNull();
    }
    // One browser on one day is one visitor.
    expect(new Set(docs.map((d) => d.data._visitor)).size).toBe(1);
    expect(query.body).not.toContain('127.0.0.1');
    expect(query.body).not.toContain('Browser/1.0');

    // The page learns its endpoint, without a token: this one needs none.
    const info = JSON.parse((await call(site, 'GET', '/__lager/ingest', { headers: { Cookie: inst } })).body);
    expect(info.endpoints).toEqual([{ name: 'hits', path: '/_ingest/hits', collection: 'hits', auth: 'none', origins: ['https://blog.example.com'], maxBytes: 1024, enabled: true, token: null }]);
  });
});
