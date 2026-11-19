import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { backup } from '../src/backup.js';
import { createCore, DEPLOYS_PER_HOUR } from '../src/core.js';
import { apiExtension } from '../src/http/api.js';
import { mcpExtension } from '../src/mcp/http.js';
import { deployWithIcon } from '../src/mcp/tools.js';
import { AiError, AiModels, DEFAULT_GROUP } from '../src/platform/ai.js';
import { MAX_DEPLOYED_VERSIONS } from '../src/platform/apps.js';
import { openPlatformDb } from '../src/platform/db.js';
import { createMailer } from '../src/platform/mail.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
const servers: Array<http.Server | net.Server> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    if ('closeAllConnections' in s) s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  h?.core.close();
  h = undefined;
});

const PAGE = '<!doctype html><html><head><title>x</title></head><body></body></html>';
const rules = (write: string): { db: { rules: Array<{ path: string; write: string }> } } => ({ db: { rules: [{ path: 'votes', write }] } });

async function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** Sends the bytes as they are and returns everything the server answers until it closes the connection. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let out = '';
    socket.on('data', (d) => { out += String(d); });
    socket.on('close', () => resolve(out));
    socket.on('error', reject);
  });
}

describe('requests the client got wrong', () => {
  it('are answered with their 4xx status and not logged as server errors', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    h = makeHarness();
    const port = await listen(http.createServer(h.app));
    // No Host header at all: an HTTP/1.0 probe.
    expect(await raw(port, 'GET / HTTP/1.0\r\n\r\n')).toMatch(/^HTTP\/1\.1 404 /);
    // A percent-encoding that is not UTF-8, in a path with a parameter.
    expect(await raw(port, `GET /lang/%E0%A4%A HTTP/1.1\r\nHost: ${h.host}\r\nConnection: close\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400 /);
    const form = (headers: Record<string, string>, body: string) => request(h!.app).post('/login').set('Host', h!.host).set(headers).send(body);
    expect((await form({ 'Content-Type': 'application/x-www-form-urlencoded; charset=klingon' }, 'a=b')).status).toBe(415);
    expect((await form({ 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Encoding': 'lzma' }, 'a=b')).status).toBe(415);
    expect((await form({ 'Content-Type': 'application/x-www-form-urlencoded' }, 'a='.padEnd(2 * 1024 * 1024, 'x'))).status).toBe(413);
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('deploy parameters', () => {
  it('title and note are one line of bounded plain text', () => {
    h = makeHarness();
    const { core, adminId } = h;
    const deploy = (extra: object) => core.apps.deploy({ slug: 'notes', html: PAGE, userId: adminId, ...extra });
    expect(() => deploy({ title: 'x'.repeat(101) })).toThrow(expect.objectContaining({ code: 'invalid_argument', message: 'title must be at most 100 characters.' }));
    expect(() => deploy({ note: 'x'.repeat(501) })).toThrow(expect.objectContaining({ code: 'invalid_argument', message: 'note must be at most 500 characters.' }));
    expect(() => deploy({ title: 'a\u0000b' })).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(() => deploy({ note: 'a\u001bb' })).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(core.apps.getApp('notes')).toBeNull();
    const r = deploy({ title: '  My\n notes ', note: ' first\r\n\tversion ' });
    expect(r.app.title).toBe('My notes');
    expect(r.version.note).toBe('first version');
    // A redeploy is held to the same limits, and a title of only spaces changes nothing.
    expect(() => core.apps.deploy({ slug: 'notes', html: PAGE + '<!-- 2 -->', title: 'y'.repeat(101), userId: adminId })).toThrow(/title/);
    expect(core.apps.deploy({ slug: 'notes', html: PAGE + '<!-- 2 -->', title: '   ', note: '  ', userId: adminId })).toMatchObject({ app: { title: 'My notes' }, version: { number: 2, note: null } });
  });

  it('the REST deploy refuses a title that is too long', async () => {
    h = makeHarness({ extensions: [apiExtension] });
    const token = h.core.tokens.create(h.adminId, 't').token;
    const res = await request(h.app).put('/api/apps/notes').query({ title: 'x'.repeat(101) }).set('Host', h.host)
      .set('Authorization', `Bearer ${token}`).type('text/html').send(PAGE);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/title must be at most 100/);
  });
});

describe('start without an administrator', () => {
  it('is refused while there is no account, and fine once there is one', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-noadmin-'));
    const config = {
      dataDir, port: 0, defaultLocale: 'en' as const, publicUrl: new URL('http://lager.localhost:8080'), appsDomain: 'apps.localhost',
      secret: 's'.repeat(32), snapshotKeep: 20, trustProxy: false as const, instanceQuotaBytes: 0,
    };
    const both = /LAGER_ADMIN_EMAIL.*LAGER_ADMIN_PASSWORD/s;
    expect(() => createCore(config)).toThrow(both);
    expect(() => createCore({ ...config, adminEmail: 'admin@x.y' })).toThrow(both);
    expect(() => createCore({ ...config, adminPassword: 'admin-password-1' })).toThrow(both);
    createCore({ ...config, adminEmail: 'admin@x.y', adminPassword: 'admin-password-1' }).close();
    // The password line may be removed after the first start.
    const later = createCore(config);
    expect(later.users.count()).toBe(1);
    later.close();
  });
});

describe('apps and instances', () => {
  it('a manager who may not switch to other data rules cannot do it through automatic updates either', () => {
    h = makeHarness();
    const { core, adminId } = h;
    const manager = core.users.create({ email: 'm@x.y', name: 'M', password: 'pw-pw-pw-pw', role: 'user' });
    const inst = core.apps.deploy({ slug: 'poll', html: PAGE, capabilities: rules('owner') as never, userId: adminId }).instances[0];
    core.apps.setAutoUpdate(inst.id, false, adminId);
    core.apps.deploy({ slug: 'poll', html: PAGE + '<!-- 2 -->', capabilities: rules('interact') as never, userId: adminId });
    core.access.setGrant(inst, 'user', manager.id, 'admin', core.users.get(adminId)!);
    expect(() => core.apps.setAutoUpdate(inst.id, true, manager.id)).toThrow(expect.objectContaining({ reason: 'rules_differ' }));
    expect(core.apps.getInstance(inst.id)).toMatchObject({ autoUpdate: false, activeVersion: 1 });
    expect(core.apps.setAutoUpdate(inst.id, true, adminId)).toMatchObject({ autoUpdate: true, activeVersion: 2 });
  });

  it('deleting an instance frees its custom domain and drops its uploads even when its data cannot be moved to the trash', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h = makeHarness();
    const { core, adminId } = h;
    const admin = core.users.get(adminId)!;
    const first = core.apps.deploy({ slug: 'notes', html: PAGE, userId: adminId }).instances[0];
    const second = core.apps.deploy({ slug: 'other', html: PAGE, userId: adminId }).instances[0];
    core.data.set(first.id, 'tasks/t1', { a: 1 }, adminId);
    core.domains.add(first, 'notes.example.org', admin, true);
    fs.writeFileSync(path.join(core.config.dataDir, 'trash'), 'not a directory');
    expect(() => core.apps.deleteInstance(first.id, adminId)).toThrow();
    expect(core.apps.getInstance(first.id)).toBeNull();
    expect(core.domains.instanceIdFor('notes.example.org')).toBeNull();
    expect(core.domains.add(second, 'notes.example.org', admin, true)).toBe('notes.example.org');
  });

  it('deleting an app runs the clean-up of every instance even when one fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h = makeHarness();
    const { core, adminId } = h;
    const admin = core.users.get(adminId)!;
    const first = core.apps.deploy({ slug: 'notes', html: PAGE, userId: adminId }).instances[0];
    const second = core.apps.createInstance({ appId: first.appId, slug: 'notes-2', ownerId: adminId });
    core.data.set(first.id, 'tasks/t1', { a: 1 }, adminId);
    core.domains.add(first, 'one.example.org', admin, true);
    core.domains.add(second, 'two.example.org', admin, true);
    fs.writeFileSync(path.join(core.config.dataDir, 'trash'), 'not a directory');
    expect(() => core.apps.deleteApp(first.appId, adminId)).toThrow();
    expect(core.apps.getApp('notes')).toBeNull();
    expect(core.domains.instanceIdFor('one.example.org')).toBeNull();
    expect(core.domains.instanceIdFor('two.example.org')).toBeNull();
  });

  it("the platform's own label under the apps domain cannot become an instance", () => {
    h = makeHarness({ publicUrl: 'http://hub.apps.localhost:8080' });
    const { core, adminId } = h;
    expect(() => core.apps.deploy({ slug: 'hub', html: PAGE, userId: adminId })).toThrow(expect.objectContaining({ reason: 'slug_reserved' }));
    const made = core.apps.deploy({ slug: 'hub2', html: PAGE, userId: adminId });
    expect(made.createdApp).toBe(true);
    expect(() => core.apps.createInstance({ appId: made.app.id, slug: 'hub', ownerId: adminId })).toThrow(expect.objectContaining({ reason: 'slug_reserved' }));
  });

  it('names of common infrastructure are refused for new apps and instances, while an app that has one keeps deploying', () => {
    h = makeHarness();
    const { core, adminId } = h;
    const names = ['www', 'api', 'admin', 'login', 'auth', 'account', 'accounts', 'mail', 'smtp', 'ftp', 'static', 'assets', 'cdn', 'status', 'support', 'security'];
    const made = core.apps.deploy({ slug: 'notes', html: PAGE, userId: adminId });
    for (const slug of names) {
      expect(() => core.apps.deploy({ slug, html: PAGE, userId: adminId }), slug).toThrow(expect.objectContaining({ code: 'invalid_argument', reason: 'slug_reserved' }));
      expect(() => core.apps.createInstance({ appId: made.app.id, slug, ownerId: adminId }), slug).toThrow(expect.objectContaining({ reason: 'slug_reserved' }));
    }
    // An app from before the name was reserved: renamed in the database, as an older release would have left it.
    const db = openPlatformDb(core.config.dataDir);
    db.prepare("UPDATE apps SET slug = 'login' WHERE id = ?").run(made.app.id);
    db.prepare("UPDATE instances SET slug = 'login' WHERE app_id = ?").run(made.app.id);
    db.close();
    const again = core.apps.deploy({ slug: 'login', html: PAGE + '<!-- 2 -->', userId: adminId });
    expect(again).toMatchObject({ createdApp: false, createdVersion: true, version: { number: 2 } });
    expect(core.apps.getInstanceBySlug('login')!.activeVersion).toBe(2);
  });
});

describe('deployed versions', () => {
  it('an app keeps its newest versions and every version an instance runs; the files of the others are deleted', () => {
    h = makeHarness();
    const { core, adminId } = h;
    const deploy = (n: number) => core.apps.deploy({ slug: 'notes', html: `${PAGE}<!-- ${n} -->`, userId: adminId });
    const first = deploy(1);
    const appId = first.app.id;
    // One instance stays on version 1 (pinned), one was rolled back to version 3 and follows deploys no longer.
    const pinned = core.apps.createInstance({ appId, slug: 'pinned', ownerId: adminId });
    core.apps.setAutoUpdate(pinned.id, false, adminId);
    deploy(2);
    deploy(3);
    const rolled = core.apps.createInstance({ appId, slug: 'rolled', ownerId: adminId });
    core.apps.setAutoUpdate(rolled.id, false, adminId);
    const total = MAX_DEPLOYED_VERSIONS + 5;
    for (let n = 4; n <= total; n++) deploy(n);
    const numbers = core.apps.listVersions(appId).map((v) => v.number);
    const newest = Array.from({ length: MAX_DEPLOYED_VERSIONS }, (_, i) => total - MAX_DEPLOYED_VERSIONS + 1 + i);
    expect(numbers).toEqual([1, 3, ...newest]);
    const dir = path.join(core.config.dataDir, 'apps', appId, 'versions');
    expect(fs.readdirSync(dir).map(Number).sort((a, b) => a - b)).toEqual(numbers);
    expect(fs.existsSync(path.join(core.config.dataDir, 'trash'))).toBe(false);
    expect(core.apps.readVersionHtml(appId, 1)).toContain('<!-- 1 -->');
    expect(core.apps.getInstance(pinned.id)!.activeVersion).toBe(1);
    expect(core.apps.getInstance(rolled.id)!.activeVersion).toBe(3);
    expect(core.apps.getInstanceBySlug('notes')!.activeVersion).toBe(total);
    // Version numbers are never reused.
    expect(deploy(total + 1).version.number).toBe(total + 1);
  });

  it('an app takes a limited number of deploys per hour, and only from people who may deploy it', async () => {
    h = makeHarness();
    const { core, adminId } = h;
    const admin = core.users.get(adminId)!;
    const other = core.users.create({ email: 'p@x.y', name: 'P', password: 'pw-pw-pw-pw', role: 'publisher' });
    await deployWithIcon(core, admin, { slug: 'notes', html: PAGE });
    // Someone else's refused deploys do not use up the app's budget.
    for (let i = 0; i < DEPLOYS_PER_HOUR + 1; i++) {
      await expect(deployWithIcon(core, other, { slug: 'notes', html: PAGE })).rejects.toMatchObject({ code: 'forbidden' });
    }
    for (let i = 1; i < DEPLOYS_PER_HOUR; i++) await deployWithIcon(core, admin, { slug: 'notes', html: PAGE });
    await expect(deployWithIcon(core, admin, { slug: 'notes', html: PAGE + '<!-- more -->' })).rejects.toMatchObject({ code: 'conflict', reason: 'deploy_rate' });
    expect(core.apps.listVersions(core.apps.getApp('notes')!.id)).toHaveLength(1);
    // The budget is per app.
    await deployWithIcon(core, admin, { slug: 'other', html: PAGE });
  });

  it('the REST deploy is held to the same limit', async () => {
    h = makeHarness({ extensions: [apiExtension] });
    const token = h.core.tokens.create(h.adminId, 't').token;
    const put = () => request(h!.app).put('/api/apps/notes').set('Host', h!.host).set('Authorization', `Bearer ${token}`).type('text/html').send(PAGE);
    expect((await put()).status).toBe(200);
    for (let i = 1; i < DEPLOYS_PER_HOUR; i++) h.core.deployLimiter.hit('notes');
    const res = await put();
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/60 times within an hour/);
  });
});

describe('backup', () => {
  it('a file uploaded while the backup runs is never referenced by the copied database without being in the backup', () => {
    h = makeHarness();
    const { core, adminId } = h;
    const inst = core.apps.deploy({ slug: 'notes', html: PAGE, userId: adminId }).instances[0];
    core.assets.put(inst.id, Buffer.from('first'), 'text/plain', adminId);
    const blobs = path.join(core.config.dataDir, 'instances', inst.id, 'assets');
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-backup-')), 'copy');
    const readdir = fs.readdirSync;
    let uploaded = false;
    // The worst case for the copy order: directories are listed before the files next to them, and an upload arrives right
    // after the directory of the files was read.
    fs.readdirSync = ((dir: fs.PathLike, options: { withFileTypes: true }) => {
      const entries = readdir(dir, options);
      if (options?.withFileTypes) entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()));
      if (String(dir) === blobs && !uploaded) {
        uploaded = true;
        core.assets.put(inst.id, Buffer.from('second'), 'text/plain', adminId);
      }
      return entries;
    }) as typeof fs.readdirSync;
    try {
      backup(core.config.dataDir, target);
    } finally {
      fs.readdirSync = readdir;
    }
    expect(uploaded).toBe(true);
    const restored = createCore({ ...core.config, dataDir: target });
    try {
      const listed = restored.assets.list(inst.id);
      expect(listed.length).toBeGreaterThanOrEqual(1);
      for (const a of listed) expect(fs.existsSync(restored.assets.get(inst.id, a.id)!.path), a.id).toBe(true);
    } finally {
      restored.close();
    }
  });
});

describe('mail', () => {
  it('gives up on a mail server that accepts the connection and then says nothing', async () => {
    const silent = net.createServer(() => { /* never greets */ });
    const sockets: net.Socket[] = [];
    silent.on('connection', (s) => sockets.push(s));
    const port = await listen(silent);
    h = makeHarness();
    const mailer = createMailer({ ...h.core.config, smtpUrl: `smtp://127.0.0.1:${port}` }, 150);
    const started = Date.now();
    await expect(mailer.send({ to: 'a@x.y', subject: 's', text: 't' })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    for (const s of sockets) s.destroy();
  });
});

describe('language model time limit', () => {
  function models(fake: (init: RequestInit) => Promise<Response>, timeoutMs: number) {
    const db = openPlatformDb(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-ai-')));
    const ai = new AiModels(db, 's', ((_url: string, init: RequestInit) => fake(init)) as unknown as typeof fetch, timeoutMs);
    const provider = ai.createProvider({ name: 'P', type: 'ollama' });
    const model = ai.createModel({ id: 'm', providerId: provider.id, model: 'llama' });
    ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: model.id, hourlyLimit: 10 });
    return { ai, db, route: ai.routeFor('anyone')! };
  }
  const timeout = expect.objectContaining({ reason: 'timeout', status: 504 });

  it('a provider that does not answer in time ends as the timeout error', async () => {
    const { ai, db, route } = models((init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }), 40);
    const err = await ai.complete(route, [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    db.close();
    expect(err).toBeInstanceOf(AiError);
    expect(err).toEqual(timeout);
  });

  it('so does an answer that starts and then stalls', async () => {
    const { ai, db, route } = models(async (init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":'));
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
      },
    })), 40);
    const err = await ai.complete(route, [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    db.close();
    expect(err).toBeInstanceOf(AiError);
    expect(err).toEqual(timeout);
  });

  it('the limit comes from the configuration', async () => {
    h = makeHarness();
    h.core.close();
    const seen: number[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const core = createCore({ ...h.core.config, aiTimeoutSeconds: 7 }, { fetch: (async () => new Response('{}')) as unknown as typeof fetch });
    h = { ...h, core };
    const provider = core.ai.createProvider({ name: 'P', type: 'ollama' });
    const model = core.ai.createModel({ id: 'm', providerId: provider.id, model: 'llama' });
    core.ai.updateGroup(DEFAULT_GROUP, { name: '', modelId: model.id, hourlyLimit: 10 });
    await core.ai.complete(core.ai.routeFor(h.adminId)!, [{ role: 'user', content: 'hi' }]).catch(() => {});
    for (const c of spy.mock.calls) seen.push(c[0]);
    expect(seen).toEqual([7000]);
  });
});

describe('mcp endpoint', () => {
  it('a transport that fails to close is logged and does not end the process', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'close').mockRejectedValue(new Error('close failed'));
    h = makeHarness({ extensions: [mcpExtension] });
    const token = h.core.tokens.create(h.adminId, 'mcp').token;
    const res = await request(h.app).post('/mcp').set('Host', h.host).set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(logged.some((args) => String(args[0]).includes('closing an MCP transport failed'))).toBe(true);
  });
});
