import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSlug, instanceUrl, loadConfig } from '../src/config.js';
import { LagerError } from '../src/errors.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-config-'));

describe('config', () => {
  it('parses env', () => {
    const env = { LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: tmp };
    const c = loadConfig(env);
    expect(c.port).toBe(8080);
    expect(c.snapshotKeep).toBe(20);
    expect(c.trustProxy).toBe(1);
    expect(instanceUrl(c, 'workout')).toBe('http://workout.apps.localhost:8080');
    expect(c.secret).toHaveLength(64);
    expect(loadConfig({ ...env }).secret).toBe(c.secret);
    expect(fs.readFileSync(path.join(tmp, 'secret.key'), 'utf8').trim()).toBe(c.secret);
  });

  it('defaults the port to 8080 whatever the public url says', () => {
    const base = { LAGER_APPS_DOMAIN: 'apps.example.org', LAGER_DATA_DIR: tmp };
    expect(loadConfig({ ...base, LAGER_PUBLIC_URL: 'https://lager.example.org' }).port).toBe(8080);
    expect(loadConfig({ ...base, LAGER_PUBLIC_URL: 'https://lager.example.org:9443' }).port).toBe(8080);
    expect(loadConfig({ ...base, LAGER_PUBLIC_URL: 'https://lager.example.org', LAGER_PORT: '3000' }).port).toBe(3000);
  });

  it('parses LAGER_HOST and LAGER_ACCESS_LOG', () => {
    const base = { LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: tmp };
    expect(loadConfig(base).host).toBeUndefined();
    expect(loadConfig(base).accessLog).toBe(false);
    expect(loadConfig({ ...base, LAGER_HOST: ' 127.0.0.1 ', LAGER_ACCESS_LOG: 'TRUE' })).toMatchObject({ host: '127.0.0.1', accessLog: true });
    expect(loadConfig({ ...base, LAGER_HOST: '', LAGER_ACCESS_LOG: '0' })).toMatchObject({ accessLog: false });
    expect(() => loadConfig({ ...base, LAGER_ACCESS_LOG: 'yes' })).toThrow(/LAGER_ACCESS_LOG/);
  });

  it('parses LAGER_TRUST_PROXY as hop count', () => {
    const base = { LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: tmp };
    const trust = (v?: string) => loadConfig({ ...base, ...(v === undefined ? {} : { LAGER_TRUST_PROXY: v }) }).trustProxy;
    expect(trust()).toBe(1);
    expect(trust('true')).toBe(1);
    expect(trust('false')).toBe(false);
    expect(trust('0')).toBe(false);
    expect(trust('2')).toBe(2);
    expect(() => trust('-1')).toThrow(/LAGER_TRUST_PROXY/);
    expect(() => trust('lots')).toThrow(/LAGER_TRUST_PROXY/);
  });

  it('takes the secret from LAGER_SECRET when set', () => {
    const c = loadConfig({ LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: tmp, LAGER_SECRET: ' from-env ' });
    expect(c.secret).toBe('from-env');
  });

  it('requires LAGER_PUBLIC_URL and LAGER_APPS_DOMAIN', () => {
    expect(() => loadConfig({})).toThrow(/LAGER_PUBLIC_URL/);
    expect(() => loadConfig({ LAGER_PUBLIC_URL: 'http://a.test' })).toThrow(/LAGER_APPS_DOMAIN/);
  });

  it('rejects bad slugs', () => {
    for (const s of ['', 'A', '-a', 'a-', 'a_b', 'www', 'mcp', 'x'.repeat(64)]) {
      expect(() => assertSlug(s)).toThrow(LagerError);
    }
    assertSlug('a');
    assertSlug('workout-2');
  });

  it('mail and quota settings', () => {
    const env = { LAGER_PUBLIC_URL: 'https://lager.example.org', LAGER_APPS_DOMAIN: 'apps.example.org', LAGER_DATA_DIR: tmp };
    const c = loadConfig(env);
    expect(c.instanceQuotaBytes).toBe(50 * 1024 * 1024);
    expect(c.smtpUrl).toBeUndefined();
    expect(c.mailFrom).toContain('lager.example.org');
    const d = loadConfig({ ...env, LAGER_INSTANCE_QUOTA_MB: '1', LAGER_SMTP_URL: 'smtp://u:p@mail.example.org:587', LAGER_MAIL_FROM: 'X <x@example.org>' });
    expect(d.instanceQuotaBytes).toBe(1048576);
    expect(d.smtpUrl).toBe('smtp://u:p@mail.example.org:587');
    expect(d.mailFrom).toBe('X <x@example.org>');
  });
});
