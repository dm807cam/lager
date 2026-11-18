import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core.js';
import { checkArtifact, SUPPORTED_CAPABILITIES } from '../src/platform/check.js';
import { lintArtifact } from '../src/platform/lint.js';

let core: Core | undefined;
afterEach(() => { core?.close(); core = undefined; });

describe('checkArtifact', () => {
  it('lists the capabilities Lager provides', () => {
    expect([...SUPPORTED_CAPABILITIES].sort()).toEqual(['artifact', 'assets', 'db', 'downloads', 'permissions', 'room', 'self', 'user']);
  });

  it('finds used capabilities in both quote styles', () => {
    const html = `<script>
      const a = await window.claude.use( "assets" );
      const b = await claude.use('room');
      const c = await claude.use("db"); const d = await claude.use("db");
    </script>`;
    expect(checkArtifact(html, { db: {}, room: {}, assets: {} }).used).toEqual(['assets', 'db', 'room']);
  });

  it('treats a capability as declared only when its value is an object', () => {
    const html = '<script>claude.use("db"); claude.use("room"); claude.use("assets")</script>';
    expect(checkArtifact(html, { db: {}, room: true, assets: null } as never).undeclared).toEqual(['assets', 'room']);
  });

  it('ignores calls whose argument is not a string literal', () => {
    expect(checkArtifact('<script>claude.use(name); claude.use(`x${y}`)</script>').used).toEqual([]);
  });

  it('reports unsupported and undeclared ones', () => {
    const html = '<script>claude.use("sample"); claude.use("tts"); claude.use("db"); claude.use("permissions");</script>';
    const r = checkArtifact(html, {});
    expect(r.used).toEqual(['db', 'permissions', 'sample', 'tts']);
    expect(r.unsupported).toEqual(['sample', 'tts']);
    expect(r.undeclared).toEqual(['db']);
    expect(r.warnings).toContain('"sample" is not provided by Lager; claude.use("sample") returns null.');
    expect(r.warnings).toContain('"tts" is not provided by Lager; claude.use("tts") returns null.');
    expect(r.warnings).toContain('"db" is used but not declared in capabilities.');
    expect(r.warnings).toHaveLength(3);
  });

  it('treats artifact and self as aliases when declaring', () => {
    expect(checkArtifact('<script>claude.use("artifact")</script>', { self: {} }).undeclared).toEqual([]);
    expect(checkArtifact('<script>claude.use("self")</script>', { artifact: {} }).undeclared).toEqual([]);
    expect(checkArtifact('<script>claude.use("self")</script>', {}).undeclared).toEqual(['self']);
  });

  it('without a declaration given every used supported capability is undeclared', () => {
    expect(checkArtifact('<script>claude.use("user")</script>').undeclared).toEqual(['user']);
  });

  it('warns about claude.complete and browser storage', () => {
    const r = checkArtifact('<script>window.claude.complete("hi"); localStorage.x = 1</script>', {});
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings.some((w) => w.includes('localStorage'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('"complete" is not declared'))).toBe(true);
    expect(checkArtifact('<script>const f = claude.complete; f()</script>', {}).warnings).toHaveLength(0);
    expect(checkArtifact('<script>claude.complete ("x")</script>', {}).warnings).toHaveLength(2);
  });

  it('claude.complete needs the complete declaration', () => {
    expect(checkArtifact('<script>claude.complete("x")</script>', {}).undeclared).toEqual(['complete']);
    const declared = checkArtifact('<script>claude.complete("x")</script>', { complete: {} });
    expect(declared.undeclared).toEqual([]);
    expect(declared.unsupported).toEqual([]);
    expect(declared.warnings).toHaveLength(1);
  });

  it('clean artifact has no warnings', () => {
    const r = checkArtifact('<p>hi</p><script>claude.use("db")</script>', { db: {} });
    expect(r).toEqual({ used: ['db'], unsupported: [], undeclared: [], warnings: [] });
  });

  it('lintArtifact reports only the storage rules', () => {
    expect(lintArtifact('<script>claude.use("db"); claude.complete(); indexedDB.open("x")</script>')).toHaveLength(1);
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
      html: '<script>claude.use("db"); claude.use("sample"); sessionStorage.x=1</script>',
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
