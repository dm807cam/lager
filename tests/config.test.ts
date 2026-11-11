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
    expect(c.trustProxy).toBe(true);
    expect(instanceUrl(c, 'workout')).toBe('http://workout.apps.localhost:8080');
    expect(c.secret).toHaveLength(64);
    expect(loadConfig({ ...env }).secret).toBe(c.secret);
    expect(fs.readFileSync(path.join(tmp, 'secret.key'), 'utf8').trim()).toBe(c.secret);
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
