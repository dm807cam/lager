import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Config } from '../../src/config.js';
import { createCore, type Core } from '../../src/core.js';
import { createHttpApp, type PlatformExtension } from '../../src/http/app.js';

export const PLATFORM_HOST = 'lager.localhost';

export interface Harness {
  core: Core;
  app: ReturnType<typeof createHttpApp>;
  adminId: string;
  /** Host header value of the platform host (`host[:port]` of publicUrl). */
  host: string;
  /** Logs in on the platform host and returns the platform cookie pair `name=value`. */
  login(email?: string, password?: string): Promise<string>;
  /** Walks /auth/instance and the callback; returns the instance cookie pair. */
  enter(slug: string, platformCookie: string): Promise<string>;
}

export interface HarnessOptions { publicUrl?: string; extensions?: PlatformExtension[] }

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-http-'));
  const config: Config = {
    dataDir, port: 0, publicUrl: new URL(opts.publicUrl ?? 'http://lager.localhost:8080'), appsDomain: 'apps.localhost',
    adminEmail: 'admin@x.y', adminPassword: 'pw', secret: 'test-secret', snapshotKeep: 20, trustProxy: false,
  };
  const core = createCore(config);
  const app = createHttpApp(core, opts.extensions ?? []);
  const host = config.publicUrl.host;
  const adminId = core.users.list()[0].id;
  const cookiePair = (res: request.Response, name: string): string => {
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(name + '='));
    if (!raw) throw new Error(`no ${name} cookie`);
    return raw.split(';')[0];
  };
  return {
    core, app, adminId, host,
    async login(email = 'admin@x.y', password = 'pw') {
      const res = await request(app).post('/login').set('Host', host).type('form').send({ email, password });
      return cookiePair(res, 'lager_session');
    },
    async enter(slug, platformCookie) {
      const auth = await request(app).get('/auth/instance').query({ slug, return: '/' })
        .set('Host', host).set('Cookie', platformCookie);
      const loc = new URL(auth.headers.location);
      const cb = await request(app).get(loc.pathname + loc.search).set('Host', loc.host);
      return cookiePair(cb, 'lager_inst');
    },
  };
}
