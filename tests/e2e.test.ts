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
import { dashboardExtension } from '../src/http/dashboard.js';
import { mcpExtension } from '../src/mcp/http.js';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

async function boot(): Promise<{ core: Core; call: (host: string, method: string, url: string, opts?: { headers?: Record<string, string>; body?: string }) => Promise<Res> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-e2e-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.localhost:8080'), appsDomain: 'apps.localhost',
    adminEmail: 'admin@x.y', adminPassword: 'pw', secret: 'e2e-secret', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
  };
  const core = createCore(config);
  const server = http.createServer(createHttpApp(core, [authExtension, apiExtension, mcpExtension, dashboardExtension]));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup = () => { server.closeAllConnections(); server.close(); core.close(); };
  const port = (server.address() as AddressInfo).port;
  // Plain http request with an explicit Host header, so the host routing is exercised on a real socket.
  const call = (host: string, method: string, url: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
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

describe('end to end', () => {
  it('deploy → open → store → redeploy → rollback keeps data', async () => {
    const { core, call } = await boot();
    const platform = 'lager.localhost:8080';
    const adminId = core.users.list()[0].id;
    const { token } = core.tokens.create(adminId, 'e2e');
    const auth = { Authorization: `Bearer ${token}` };
    const v1 = fs.readFileSync(new URL('../examples/notes.html', import.meta.url), 'utf8');
    const v2 = v1.replace('</body>', '<p id="v2-marker">zweite Version</p></body>');
    expect(v2).not.toBe(v1);
    const put = (html: string) => call(platform, 'PUT', '/api/apps/notes?title=Notizen&capabilities=' + encodeURIComponent('{"db":{},"user":{}}'),
      { headers: { ...auth, 'Content-Type': 'text/html' }, body: html });

    // 1. deploy through the REST API
    const first = await put(v1);
    expect(first.status).toBe(200);
    const deployed = JSON.parse(first.body) as { urls: string[]; version: number };
    expect(deployed.version).toBe(1);
    const instHost = new URL(deployed.urls[0]).host;
    expect(instHost).toBe('notes.apps.localhost:8080');

    // 2. anonymous visit is sent to the platform
    const anon = await call(instHost, 'GET', '/');
    expect(anon.status).toBe(302);
    expect(new URL(anon.headers.location!).host).toBe(platform);
    expect(new URL(anon.headers.location!).pathname).toBe('/auth/instance');

    // 3. sign in on the platform and follow the handshake
    const login = await call(platform, 'POST', '/login', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=admin%40x.y&password=pw',
    });
    const session = cookiePair(login, 'lager_session');
    const loc = new URL(anon.headers.location!);
    const handshake = await call(platform, 'GET', loc.pathname + loc.search, { headers: { Cookie: session } });
    expect(handshake.status).toBe(302);
    const cb = new URL(handshake.headers.location!);
    expect(cb.host).toBe(instHost);
    expect(cb.pathname).toBe('/__lager/callback');
    const callback = await call(instHost, 'GET', cb.pathname + cb.search);
    const inst = { Cookie: cookiePair(callback, 'lager_inst') };

    // 4. the instance serves the example with the runtime injected
    const page = await call(instHost, 'GET', '/', { headers: inst });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script src="/__lager/runtime.js"></script>');
    expect(page.body).toContain('id="notes"');
    const runtime = await call(instHost, 'GET', '/__lager/runtime.js', { headers: inst });
    expect(runtime.status).toBe(200);
    expect(runtime.body.length).toBeGreaterThan(100);

    // 5. write and read a document
    const db = (body: unknown) => call(instHost, 'POST', '/__lager/db', {
      headers: { ...inst, 'Content-Type': 'application/json', 'X-Lager-Request': '1' }, body: JSON.stringify(body),
    });
    const set = await db({ op: 'set', path: 'notes/n1', data: { text: 'hello' } });
    expect(set.status).toBe(200);
    const instance = core.apps.getInstanceBySlug('notes')!;
    const q1 = JSON.parse((await db({ op: 'query', path: 'notes' })).body) as { docs: unknown[] };
    expect(q1.docs).toHaveLength(1);

    // 6. redeploy: new version active, data intact
    const second = await put(v2);
    expect((JSON.parse(second.body) as { version: number }).version).toBe(2);
    expect((await call(instHost, 'GET', '/', { headers: inst })).body).toContain('id="v2-marker"');
    expect((JSON.parse((await db({ op: 'query', path: 'notes' })).body) as { docs: unknown[] }).docs).toHaveLength(1);

    // 7. roll back through the API
    const back = await call(platform, 'POST', '/api/instances/notes/activate', {
      headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"version":1}',
    });
    expect(back.status).toBe(200);
    const old = await call(instHost, 'GET', '/', { headers: inst });
    expect(old.body).not.toContain('id="v2-marker"');
    expect(old.body).toContain('id="notes"');
    const q2 = JSON.parse((await db({ op: 'query', path: 'notes' })).body) as { docs: Array<{ data?: { text?: string }; text?: string }> };
    expect(q2.docs).toHaveLength(1);
    expect(JSON.stringify(q2.docs[0])).toContain('hello');

    // 8. both switches left a snapshot
    const labels = core.data.listSnapshots(instance.id).map((s) => s.label);
    expect(labels).toContain('v1-to-v2');
    expect(labels).toContain('v2-to-v1');
  });
});
