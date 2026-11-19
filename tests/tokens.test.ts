import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';

let core: Core | undefined;
afterEach(() => { core?.close(); core = undefined; });

function make(): Core {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-tokens-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test',
    adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 's', snapshotKeep: 20, trustProxy: false,
  };
  core = createCore(config);
  return core;
}

describe('api tokens', () => {
  it('create/verify/revoke', () => {
    const c = make();
    const admin = c.users.list()[0];
    const { token, info } = c.tokens.create(admin.id, 'laptop');
    expect(token.startsWith('lgr_')).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(4 + 43);
    expect(info).toMatchObject({ name: 'laptop', userId: admin.id, lastUsedAt: null });

    expect(c.tokens.verify(token)?.id).toBe(admin.id);
    expect(c.tokens.list(admin.id)[0].lastUsedAt).not.toBeNull();

    // only the hash is stored
    const db = new DatabaseSync(path.join(c.config.dataDir, 'platform.sqlite'));
    const rows = db.prepare('SELECT * FROM api_tokens').all();
    db.close();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(token.slice(4));

    expect(c.tokens.verify('garbage')).toBeNull();
    expect(c.tokens.verify('lgr_garbage')).toBeNull();
    expect(c.tokens.verify('')).toBeNull();

    expect(c.tokens.revoke('someone-else', info.id)).toBe(false);
    expect(c.tokens.verify(token)?.id).toBe(admin.id);
    expect(c.tokens.revoke(admin.id, info.id)).toBe(true);
    expect(c.tokens.verify(token)).toBeNull();
    expect(c.tokens.list(admin.id)).toEqual([]);
  });

  it('rejects an empty name', () => {
    const c = make();
    expect(() => c.tokens.create(c.users.list()[0].id, '  ')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('tokens of a disabled user stop working', () => {
    const c = make();
    const other = c.users.create({ email: 'o@x.y', name: 'O', password: 'pw', role: 'user' });
    const { token } = c.tokens.create(other.id, 'laptop');
    c.oauth.registerClient({ client_id: 'cid', redirect_uris: ['http://localhost/cb'], token_endpoint_auth_method: 'none' } as never);
    const oauth = c.oauth.issueTokens('cid', other.id, 'grant', 'mcp', null);
    expect(c.tokens.verify(token)?.id).toBe(other.id);
    expect(c.oauth.verifyAccessToken(oauth.access_token)?.user.id).toBe(other.id);
    c.users.setDisabled(other.id, true);
    expect(c.tokens.verify(token)).toBeNull();
    expect(c.oauth.verifyAccessToken(oauth.access_token)).toBeNull();
    c.users.setDisabled(other.id, false);
    expect(c.tokens.verify(token)?.id).toBe(other.id);
  });
});
