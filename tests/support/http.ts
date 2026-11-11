import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Config } from '../../src/config.js';
import { createCore, type Core } from '../../src/core.js';
import { createHttpApp, type PlatformExtension } from '../../src/http/app.js';
import { authExtension } from '../../src/http/auth.js';
import type { Locale } from '../../src/i18n/index.js';
import type { Mailer } from '../../src/platform/mail.js';

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

export interface HarnessOptions { publicUrl?: string; extensions?: PlatformExtension[]; trustProxy?: number | false; instanceQuotaBytes?: number; mailer?: Mailer; defaultLocale?: Locale }

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-http-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: opts.defaultLocale ?? 'en', publicUrl: new URL(opts.publicUrl ?? 'http://lager.localhost:8080'), appsDomain: 'apps.localhost',
    adminEmail: 'admin@x.y', adminPassword: 'pw', secret: 'test-secret', snapshotKeep: 20, trustProxy: opts.trustProxy ?? false,
    instanceQuotaBytes: opts.instanceQuotaBytes ?? 50 * 1024 * 1024,
  };
  const core = createCore(config, opts.mailer ? { mailer: opts.mailer } : undefined);
  // The public account pages are part of every platform host, so every harness registers them.
  const app = createHttpApp(core, [authExtension, ...(opts.extensions ?? [])]);
  const host = config.publicUrl.host;
  const adminId = core.users.list()[0].id;
  const sessionName = config.publicUrl.protocol === 'https:' ? '__Host-lager_session' : 'lager_session';
  const instanceName = config.publicUrl.protocol === 'https:' ? '__Host-lager_inst' : 'lager_inst';
  const cookiePair = (res: request.Response, name: string): string => {
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(name + '='));
    if (!raw) throw new Error(`no ${name} cookie`);
    return raw.split(';')[0];
  };
  return {
    core, app, adminId, host,
    async login(email = 'admin@x.y', password = 'pw') {
      const res = await request(app).post('/login').set('Host', host).type('form').send({ email, password });
      return cookiePair(res, sessionName);
    },
    async enter(slug, platformCookie) {
      const auth = await request(app).get('/auth/instance').query({ slug, return: '/' })
        .set('Host', host).set('Cookie', platformCookie);
      const loc = new URL(auth.headers.location);
      const cb = await request(app).get(loc.pathname + loc.search).set('Host', loc.host);
      return cookiePair(cb, instanceName);
    },
  };
}
