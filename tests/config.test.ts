import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSlug, instanceUrl, isLoopbackHost, loadConfig } from '../src/config.js';
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
    const secret = 'from-env-'.repeat(4);
    const c = loadConfig({ LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: tmp, LAGER_SECRET: ` ${secret} ` });
    expect(c.secret).toBe(secret);
  });

  it('marks a LAGER_SECRET shorter than 32 characters as weak, and still generates one when it is empty', () => {
    const base = { LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: tmp };
    // Loading only reports it: whether that stops the start depends on what already relies on the secret (see core.test.ts).
    expect(loadConfig({ ...base, LAGER_SECRET: 'x'.repeat(31) })).toMatchObject({ secret: 'x'.repeat(31), weakSecret: true });
    expect(loadConfig({ ...base, LAGER_SECRET: `  ${'x'.repeat(31)}  ` }).weakSecret).toBe(true);
    expect(loadConfig({ ...base, LAGER_SECRET: 'x'.repeat(32) })).toMatchObject({ secret: 'x'.repeat(32), weakSecret: false });
    const generated = loadConfig({ ...base, LAGER_SECRET: '  ' });
    expect(generated.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.weakSecret).toBe(false);
    // The generated secret is read back from the data directory.
    expect(loadConfig(base)).toMatchObject({ secret: generated.secret, weakSecret: false });
  });

  it('knows the host names that only reach this machine', () => {
    for (const h of ['localhost', 'LOCALHOST', 'lager.localhost', 'localhost.', 'lager.localhost.', '127.0.0.1', '127.0.0.1.', '127.1.2.3', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['lager.example.org', 'localhost.example.org', 'localhost.evil.com', '127.0.0.1.nip.io', 'localhost..', 'notlocalhost', '[::ffff:7f00:1]',
      '192.168.1.5', '10.0.0.1', '0.0.0.0', 'lager.test', '1127.0.0.1']) expect(isLoopbackHost(h), h).toBe(false);
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

  describe('refuses values it cannot run with, naming the variable', () => {
    const base = { LAGER_PUBLIC_URL: 'https://lager.example.org', LAGER_APPS_DOMAIN: 'apps.example.org', LAGER_DATA_DIR: tmp };
    const load = (extra: Record<string, string>) => loadConfig({ ...base, ...extra });

    it('LAGER_PUBLIC_URL: http or https, host and port only', () => {
      for (const v of ['lager.example.org', 'ftp://lager.example.org', 'https://lager.example.org/lager', 'https://lager.example.org/?a=1',
        'https://lager.example.org/#top', 'https://user:pw@lager.example.org', 'https://', 'localhost:8080']) {
        expect(() => load({ LAGER_PUBLIC_URL: v }), v).toThrow(/^LAGER_PUBLIC_URL must /);
      }
      for (const v of ['https://lager.example.org', 'https://lager.example.org/', 'http://localhost:8080', 'HTTP://Lager.Example.org:9443', 'http://[::1]:8080', 'http://192.168.1.20:8080']) {
        expect(load({ LAGER_PUBLIC_URL: v }).publicUrl.pathname, v).toBe('/');
      }
    });

    it('LAGER_APPS_DOMAIN: a bare host name, nothing cut off silently', () => {
      for (const v of ['https://apps.example.org', '*.apps.example.org', '.apps.example.org', 'apps.example.org:8080', 'apps.example.org/', 'apps.example.org.',
        'apps example.org', 'apps_x.example.org', '-apps.example.org', `${'a'.repeat(64)}.example.org`]) {
        expect(() => load({ LAGER_APPS_DOMAIN: v }), v).toThrow(/^LAGER_APPS_DOMAIN must /);
      }
      expect(load({ LAGER_APPS_DOMAIN: ' Apps.Example.org ' }).appsDomain).toBe('apps.example.org');
      for (const v of ['apps.localhost', 'localhost', 'example.com', 'apps.192.168.1.20.nip.io']) expect(load({ LAGER_APPS_DOMAIN: v }).appsDomain, v).toBe(v);
    });

    it('numbers: whole, written in digits and within their range', () => {
      const bad: Array<[string, string[]]> = [
        ['LAGER_PORT', ['0', '65536', '80.5', '-1', '8080abc', '0x50', '1e3']],
        ['LAGER_SNAPSHOT_KEEP', ['0', '1.5', '-3', 'many']],
        ['LAGER_INSTANCE_QUOTA_MB', ['0', '0.5', '50MB']],
        ['LAGER_TRASH_DAYS', ['-1', '2.5', 'never']],
        ['LAGER_AI_TIMEOUT_SECONDS', ['0', '4', '601', '90s', '1.5']],
      ];
      for (const [name, values] of bad) for (const v of values) expect(() => load({ [name]: v }), `${name}=${v}`).toThrow(new RegExp(`^${name} must be a whole number`));
      expect(load({ LAGER_PORT: '1', LAGER_SNAPSHOT_KEEP: '1', LAGER_TRASH_DAYS: '0', LAGER_AI_TIMEOUT_SECONDS: '5' }))
        .toMatchObject({ port: 1, snapshotKeep: 1, trashDays: 0, aiTimeoutSeconds: 5 });
      expect(load({ LAGER_PORT: '65535', LAGER_AI_TIMEOUT_SECONDS: ' 600 ' })).toMatchObject({ port: 65535, aiTimeoutSeconds: 600 });
      expect(load({})).toMatchObject({ port: 8080, snapshotKeep: 20, trashDays: 30, aiTimeoutSeconds: 90 });
    });

    it('LAGER_SMTP_URL: an smtp or smtps address, and the value is not printed', () => {
      for (const v of ['mail.example.org', 'mail.example.org:587', 'https://mail.example.org', 'smtp://', 'smtp://user:p@ss/word@:587']) {
        const err = (() => { try { load({ LAGER_SMTP_URL: v }); return null; } catch (e) { return e as Error; } })();
        expect(err?.message, v).toMatch(/^LAGER_SMTP_URL must look like /);
        expect(err?.message, v).not.toContain('p@ss');
      }
      for (const v of ['smtp://mail.example.org', 'smtps://user:p%40ss@smtp.example.com:465', 'smtp://localhost:1025']) expect(load({ LAGER_SMTP_URL: v }).smtpUrl).toBe(v);
      expect(load({ LAGER_SMTP_URL: '  ' }).smtpUrl).toBeUndefined();
    });

    it('accepts every value of .env.example', () => {
      const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
      const env = Object.fromEntries([...example.matchAll(/^(LAGER_[A-Z_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
      expect(Object.keys(env)).toContain('LAGER_AI_TIMEOUT_SECONDS');
      expect(loadConfig({ ...env, LAGER_DATA_DIR: tmp })).toMatchObject({ port: 8080, appsDomain: 'apps.localhost', aiTimeoutSeconds: 90 });
    });

    it('a refused configuration does not create the data directory', () => {
      const dir = path.join(tmp, 'never-created');
      expect(() => loadConfig({ ...base, LAGER_DATA_DIR: dir, LAGER_PORT: 'http' })).toThrow(/LAGER_PORT/);
      expect(fs.existsSync(dir)).toBe(false);
    });
  });
});
