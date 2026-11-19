import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core.js';
import { checkApp, SUPPORTED_CAPABILITIES } from '../src/platform/check.js';

let core: Core | undefined;
afterEach(() => { core?.close(); core = undefined; });

describe('checkApp', () => {
  it('lists the capabilities Lager provides', () => {
    expect([...SUPPORTED_CAPABILITIES].sort()).toEqual(['assets', 'db', 'downloads', 'page', 'permissions', 'room', 'user']);
  });

  it('finds used capabilities in both quote styles', () => {
    const html = `<script>
      const a = await window.lager.use( "assets" );
      const b = await lager.use('room');
      const c = await lager.use("db"); const d = await lager.use("db");
    </script>`;
    expect(checkApp(html, { db: {}, room: {}, assets: {} }).used).toEqual(['assets', 'db', 'room']);
  });

  it('treats a capability as declared only when its value is an object', () => {
    const html = '<script>lager.use("db"); lager.use("room"); lager.use("assets")</script>';
    expect(checkApp(html, { db: {}, room: true, assets: null } as never).undeclared).toEqual(['assets', 'room']);
  });

  it('ignores calls whose argument is not a string literal', () => {
    expect(checkApp('<script>lager.use(name); lager.use(`x${y}`)</script>').used).toEqual([]);
  });

  it('reports unsupported and undeclared ones', () => {
    const html = '<script>lager.use("sample"); lager.use("tts"); lager.use("db"); lager.use("permissions");</script>';
    const r = checkApp(html, {});
    expect(r.used).toEqual(['db', 'permissions', 'sample', 'tts']);
    expect(r.unsupported).toEqual(['sample', 'tts']);
    expect(r.undeclared).toEqual(['db']);
    expect(r.warnings).toContain('"sample" is not provided by Lager; lager.use("sample") returns null.');
    expect(r.warnings).toContain('"tts" is not provided by Lager; lager.use("tts") returns null.');
    expect(r.warnings).toContain('"db" is used but not declared in capabilities.');
    expect(r.warnings).toHaveLength(3);
  });

  it('names no aliases: artifact and self are not capabilities', () => {
    expect(checkApp('<script>lager.use("page")</script>', { page: {} }).undeclared).toEqual([]);
    expect(checkApp('<script>lager.use("artifact"); lager.use("self")</script>', { artifact: {}, self: {} }).unsupported).toEqual(['artifact', 'self']);
  });

  it('asks to convert apps written for claude.ai', () => {
    const r = checkApp(`<script>
      const db = await window.claude.use("db");
      const answer = await claude.complete("hi");
      await window.storage.set("k", "v", true);
    </script>`, { db: {} });
    // Calls through window.claude are not Lager calls, so nothing counts as used or undeclared.
    expect(r.used).toEqual([]);
    expect(r.undeclared).toEqual([]);
    expect(r.warnings).toEqual([
      'The app uses window.claude, which does not exist on Lager - use window.lager with the same calls (lager.use, lager.complete).',
      'The app uses window.storage, which does not exist on Lager - keep the data in lager.use("db") instead.',
    ]);
    expect(checkApp('<script>const s = await storage.get("k")</script>').warnings).toHaveLength(1);
    expect(checkApp('<script>sessionStorage.get("k"); db.storage.get("x")</script>').warnings.some((w) => w.includes('window.storage'))).toBe(false);
  });

  it('without a declaration given every used supported capability is undeclared', () => {
    expect(checkApp('<script>lager.use("user")</script>').undeclared).toEqual(['user']);
  });

  it('warns about lager.complete and browser storage', () => {
    const r = checkApp('<script>window.lager.complete("hi"); localStorage.x = 1</script>', {});
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.some((w) => w.includes('localStorage'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('"complete" is not declared'))).toBe(true);
    expect(checkApp('<script>const f = lager.complete; f()</script>', {}).warnings).toHaveLength(0);
    expect(checkApp('<script>lager.complete ("x")</script>', {}).warnings).toHaveLength(2);
  });

  it('lager.complete needs the complete declaration', () => {
    expect(checkApp('<script>lager.complete("x")</script>', {}).undeclared).toEqual(['complete']);
    const declared = checkApp('<script>lager.complete("x")</script>', { complete: {} });
    expect(declared.undeclared).toEqual([]);
    expect(declared.unsupported).toEqual([]);
    expect(declared.warnings).toHaveLength(1);
  });

  it('a clean app has no warnings', () => {
    const r = checkApp('<p>hi</p><script>lager.use("db")</script>', { db: {} });
    expect(r).toEqual({ used: ['db'], unsupported: [], undeclared: [], warnings: [] });
  });

  it('deploy returns the combined warnings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-check-'));
    core = createCore({
      dataDir: dir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.localhost:8080'), appsDomain: 'apps.localhost',
      adminEmail: 'admin@x.y', adminPassword: 'pw', secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 1 << 20,
    });
    const adminId = core.users.list()[0].id;
    const r = core.apps.deploy({
      slug: 'chk', userId: adminId, capabilities: { user: {} },
      html: '<script>lager.use("db"); lager.use("sample"); sessionStorage.x=1</script>',
    });
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.some((w) => w.includes('sessionStorage'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('sample'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('"db" is used'))).toBe(true);
  });
});

describe('icon warning on deploy', () => {
  it('deploy result carries the icon warning text in English', async () => {
    const { makeHarness } = await import('./support/http.js');
    const { deployWithIcon } = await import('../src/mcp/tools.js');
    const h = makeHarness({ defaultLocale: 'de' });
    try {
      const user = h.core.users.get(h.adminId)!;
      const first = await deployWithIcon(h.core, user, { slug: 'todo', html: '<p>x</p>' }) as { warnings: string[] };
      expect(first.warnings).toEqual(['No icon supplied; a generated one is used. Pass icon_svg to set your own.']);
      const again = await deployWithIcon(h.core, user, { slug: 'todo', html: '<p>y</p>' }) as { warnings: string[] };
      expect(again.warnings).toEqual([]);
    } finally {
      h.core.close();
    }
  });

  it('an icon step that fails for another reason does not undo the deploy', async () => {
    const { makeHarness } = await import('./support/http.js');
    const { deployWithIcon } = await import('../src/mcp/tools.js');
    const { vi } = await import('vitest');
    const h = makeHarness();
    try {
      vi.spyOn(h.core.icons, 'set').mockRejectedValue(new Error('ENOSPC: no space left'));
      const user = h.core.users.get(h.adminId)!;
      const out = await deployWithIcon(h.core, user, { slug: 'todo', html: '<p>x</p>', iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"/>' }) as { version: number; warnings: string[] };
      expect(out.version).toBe(1);
      expect(out.warnings.some((w) => /icon/i.test(w))).toBe(true);
      expect(h.core.apps.getApp('todo')).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
      h.core.close();
    }
  });
});
