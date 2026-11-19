import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSET_LIMITS, InstanceAssets, normalizeAssetType } from '../src/data/assets.js';
import { Hub } from '../src/data/hub.js';
import { InstanceData } from '../src/data/store.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const MIB = 1024 * 1024;

const dirs: string[] = [];
const closers: Array<() => void> = [];
function setup(quota = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-assets-'));
  dirs.push(dir);
  const data = new InstanceData(dir, new Hub(), 5, quota);
  const assets = new InstanceAssets(dir, quota, (id) => data.usage(id));
  data.setExtraUsage((id) => assets.usage(id).bytes);
  closers.push(() => { assets.close(); data.close(); });
  return { dir, data, assets };
}
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? 'other'; }
  return 'none';
};

describe('InstanceAssets', () => {
  it('put/get/list/delete roundtrip', async () => {
    const { dir, assets } = setup();
    const a = assets.put('i1', PNG, 'image/png', 'u1');
    await new Promise((r) => setTimeout(r, 5));
    const b = assets.put('i1', Buffer.from('a,b\n1,2'), 'text/csv', null);
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    const got = assets.get('i1', a.id)!;
    expect(got.path).toBe(path.join(dir, 'instances', 'i1', 'assets', a.id));
    expect(fs.readFileSync(got.path).equals(PNG)).toBe(true);
    expect(got.info).toMatchObject({ id: a.id, contentType: 'image/png', sizeBytes: PNG.length, uploadedBy: 'u1' });
    expect(assets.list('i1').map((x) => x.id)).toEqual([b.id, a.id]);
    expect(assets.list('i1', 'u1').map((x) => x.id)).toEqual([a.id]);
    expect(assets.usage('i1')).toEqual({ files: 2, bytes: PNG.length + 7 });
    expect(assets.delete('i1', a.id)).toBe(true);
    expect(fs.existsSync(got.path)).toBe(false);
    expect(assets.get('i1', a.id)).toBeNull();
    expect(assets.delete('i1', a.id)).toBe(false);
    expect(assets.list('i1').map((x) => x.id)).toEqual([b.id]);
  });

  it('type allowlist and normalisation', () => {
    const b = Buffer.from('x');
    for (const t of ['text/html', 'application/xhtml+xml', 'application/octet-stream', '', undefined]) {
      expect(code(() => normalizeAssetType(t, b))).toBe('invalid_argument');
    }
    expect(normalizeAssetType('IMAGE/PNG; charset=x', PNG)).toBe('image/png');
    expect(normalizeAssetType('application/javascript', b)).toBe('text/javascript');
    expect(normalizeAssetType('Text/Plain;charset=utf-8', b)).toBe('text/plain');
    expect(code(() => normalizeAssetType('text/javascript', Buffer.from('<html>')))).toBe('invalid_argument');
  });

  it('binary signature must match the declared type', () => {
    expect(code(() => normalizeAssetType('image/jpeg', PNG))).toBe('invalid_argument');
    expect(code(() => normalizeAssetType('image/png', Buffer.from('<html>')))).toBe('invalid_argument');
    expect(normalizeAssetType('image/jpeg', JPEG)).toBe('image/jpeg');
    expect(normalizeAssetType('image/svg+xml', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(code(() => normalizeAssetType('image/svg+xml', Buffer.from('<html></html>')))).toBe('invalid_argument');
    expect(normalizeAssetType('application/pdf', Buffer.from('%PDF-1.7'))).toBe('application/pdf');
  });

  it('size caps per type', () => {
    const svg = Buffer.concat([Buffer.from('<svg>'), Buffer.alloc(2 * MIB)]);
    expect(code(() => normalizeAssetType('image/svg+xml', svg))).toBe('invalid_argument');
    expect(code(() => normalizeAssetType('text/css', Buffer.alloc(16 * MIB + 1, 0x61)))).toBe('invalid_argument');
    expect(normalizeAssetType('text/css', Buffer.alloc(16 * MIB, 0x61))).toBe('text/css');
    expect(code(() => normalizeAssetType('image/png', Buffer.concat([PNG, Buffer.alloc(ASSET_LIMITS.maxBytes)])))).toBe('invalid_argument');
    expect(normalizeAssetType('text/plain', Buffer.alloc(20 * MIB, 0x61))).toBe('text/plain');
  });

  it('quota counts documents plus assets', () => {
    const { data, assets } = setup(MIB);
    const big = Buffer.alloc(700 * 1024, 0x61);
    const a = assets.put('i1', big, 'text/plain', null);
    expect(code(() => assets.put('i1', big, 'text/plain', null))).toBe('quota_exceeded');
    data.set('i1', 'notes/a', { t: 'x' }, null);
    const room = MIB - data.usage('i1') - assets.usage('i1').bytes;
    const fill = assets.put('i1', Buffer.alloc(room, 0x61), 'text/plain', null);
    expect(code(() => data.set('i1', 'notes/b', { t: 'y' }, null))).toBe('quota_exceeded');
    expect(assets.delete('i1', fill.id)).toBe(true);
    expect(assets.delete('i1', a.id)).toBe(true);
    expect(data.set('i1', 'notes/b', { t: 'y' }, null).id).toBe('b');
    expect(assets.put('i1', big, 'text/plain', null).sizeBytes).toBe(big.length);
  });

  it('ids are validated', () => {
    const { dir, assets } = setup();
    assets.put('i1', PNG, 'image/png', null);
    const outside = path.join(dir, 'instances', 'i1', 'secret');
    fs.writeFileSync(outside, 'x');
    for (const id of ['../secret', 'abc', 'a'.repeat(33), '../../assets.sqlite', '']) {
      expect(assets.get('i1', id)).toBeNull();
      expect(assets.delete('i1', id)).toBe(false);
    }
    expect(fs.existsSync(outside)).toBe(true);
    expect(code(() => assets.get('../x', 'a'.repeat(32)))).toBe('invalid_argument');
    expect(code(() => assets.put('../x', PNG, 'image/png', null))).toBe('invalid_argument');
  });

  it('instances are isolated and survive reopen', () => {
    const { dir, assets } = setup();
    const a = assets.put('i1', PNG, 'image/png', 'u1');
    expect(assets.get('i2', a.id)).toBeNull();
    expect(assets.list('i2')).toEqual([]);
    expect(assets.usage('i2')).toEqual({ files: 0, bytes: 0 });
    expect(fs.existsSync(path.join(dir, 'instances', 'i2'))).toBe(false);
    assets.close();
    const again = new InstanceAssets(dir, 0, () => 0);
    expect(again.get('i1', a.id)?.info.uploadedBy).toBe('u1');
    expect(again.list('i1')).toHaveLength(1);
    again.drop('i1');
    expect(again.get('i1', a.id)?.info.id).toBe(a.id);
    again.close();
  });

  it('refuses empty bodies and a full file count', () => {
    const { assets } = setup();
    expect(code(() => assets.put('i1', Buffer.alloc(0), 'text/plain', null))).toBe('invalid_argument');
    const tiny = Buffer.from('x');
    for (let n = 0; n < ASSET_LIMITS.maxFiles; n++) assets.put('i1', tiny, 'text/plain', null);
    expect(code(() => assets.put('i1', tiny, 'text/plain', null))).toBe('conflict');
  });
});
