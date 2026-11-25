import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Config } from '../../src/config.js';
import { createCore, type Core } from '../../src/core.js';
import { createHttpApp, type PlatformExtension } from '../../src/http/app.js';
import { authExtension } from '../../src/http/auth.js';
import { staticExtension } from '../../src/http/static.js';
import type { Locale } from '../../src/i18n/index.js';
import type { Mailer } from '../../src/platform/mail.js';

export const PLATFORM_HOST = 'lager.localhost';

/** A page without what is new in every response (the script nonce): two answers that must not differ are compared like this. */
export const withoutNonce = (html: string): string => html.replace(/nonce(="|-)[A-Za-z0-9+/=]+/g, 'nonce$1…');

/** A sign-in nonce as an instance would put it into its cookie, and the cookie pair that carries it (http and https name). */
export const NONCE = 'n'.repeat(22);
export const NONCE_COOKIE = `lager_nonce=${NONCE}`;
export const NONCE_COOKIE_HTTPS = `__Host-lager_nonce=${NONCE}`;

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

export interface HarnessOptions {
  publicUrl?: string; extensions?: PlatformExtension[]; trustProxy?: number | false; instanceQuotaBytes?: number; mailer?: Mailer; defaultLocale?: Locale; accessLog?: boolean; fetch?: typeof fetch;
  ingestQuotaBytes?: number; countryHeader?: string; appsDomain?: string; smtpUrl?: string;
}

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-http-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: opts.defaultLocale ?? 'en', publicUrl: new URL(opts.publicUrl ?? 'http://lager.localhost:8080'), appsDomain: opts.appsDomain ?? 'apps.localhost',
    adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 'test-secret', snapshotKeep: 20, trustProxy: opts.trustProxy ?? false,
    instanceQuotaBytes: opts.instanceQuotaBytes ?? 50 * 1024 * 1024, accessLog: opts.accessLog,
    ...(opts.ingestQuotaBytes === undefined ? {} : { ingestQuotaBytes: opts.ingestQuotaBytes }), countryHeader: opts.countryHeader,
    ...(opts.smtpUrl ? { smtpUrl: opts.smtpUrl } : {}),
  };
  const core = createCore(config, { ...(opts.mailer ? { mailer: opts.mailer } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  // The stylesheet, the script and the public account pages are part of every platform host, so every harness registers them.
  const app = createHttpApp(core, [staticExtension, authExtension, ...(opts.extensions ?? [])]);
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
    async login(email = 'admin@x.y', password = 'admin-password-1') {
      const res = await request(app).post('/login').set('Host', host).type('form').send({ email, password });
      return cookiePair(res, sessionName);
    },
    async enter(slug, platformCookie) {
      const auth = await request(app).get('/auth/instance').query({ slug, return: '/', n: NONCE })
        .set('Host', host).set('Cookie', platformCookie);
      let location = auth.headers.location as string | undefined;
      if (location === undefined) {
        // Access through the instance's visibility alone: the platform asks before the first sign-in, and the visitor continues.
        const fields = Object.fromEntries([...auth.text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
        const answer = await request(app).post('/auth/instance').set('Host', host).set('Cookie', platformCookie).type('form').send({ ...fields, decision: 'continue' });
        location = answer.headers.location as string;
      }
      const loc = new URL(location);
      const cb = await request(app).get(loc.pathname + loc.search).set('Host', loc.host)
        .set('Cookie', config.publicUrl.protocol === 'https:' ? NONCE_COOKIE_HTTPS : NONCE_COOKIE);
      return cookiePair(cb, instanceName);
    },
  };
}
