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
});
