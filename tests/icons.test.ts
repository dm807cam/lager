import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LagerError } from '../src/errors.js';
import { defaultIconSvg } from '../src/platform/default-icon.js';
import { AppIcons, ICON_SIZES, MAX_ICON_SVG_BYTES } from '../src/platform/icons.js';

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-icons-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1f2a5c"/><circle cx="256" cy="256" r="120" fill="#f58220"/></svg>';
const ID = '11111111-2222-3333-4444-555555555555';
const wrap = (inner: string, attrs = ''): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"${attrs}>${inner}</svg>`;

function pngSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function refusal(icons: AppIcons, svg: string): LagerError {
  try { icons.validate(svg); } catch (e) { return e as LagerError; }
  throw new Error(`was accepted: ${svg.slice(0, 80)}`);
}

let icons: AppIcons;
beforeAll(async () => { icons = new AppIcons(tmp()); await icons.ready(); });

describe('default icon', () => {
  it('is deterministic, valid and differs between slugs', () => {
    expect(defaultIconSvg('todo')).toBe(defaultIconSvg('todo'));
    const seeds = ['todo', 'board', 'notes', 'poll', 'chess', 'kanban', 'recipes', 'budget', 'timer', 'quiz', 'map', 'photos'];
    const all = seeds.map(defaultIconSvg);
    expect(new Set(all).size).toBe(seeds.length);
    for (const svg of all) {
      expect(() => icons.validate(svg)).not.toThrow();
      expect(svg).not.toMatch(/<text/i);
      expect(svg).toContain('viewBox="0 0 512 512"');
    }
  });

  it('uses at least eight different glyphs', () => {
    const glyphs = new Set<string>();
    for (let i = 0; i < 200; i++) glyphs.add(defaultIconSvg(`app-${i}`).split('<!--glyph:')[1]?.split('-->')[0] ?? '');
    expect(glyphs.size).toBeGreaterThanOrEqual(8);
    expect(glyphs.has('')).toBe(false);
  });
});

describe('AppIcons', () => {
  it('set renders every size and the maskable variant as real PNGs', async () => {
    await icons.set(ID, GOOD, '#1f2a5c');
    for (const size of ICON_SIZES) expect(pngSize(icons.png(ID, size)!)).toEqual({ w: size, h: size });
    expect(pngSize(icons.png(ID, 512, true)!)).toEqual({ w: 512, h: 512 });
    expect(icons.png(ID, 512, true)).not.toBe(icons.png(ID, 512));
    expect(fs.readFileSync(icons.png(ID, 512, true)!).equals(fs.readFileSync(icons.png(ID, 512)!))).toBe(false);
    expect(icons.has(ID)).toBe(true);
    expect(icons.png(ID, 100 as never)).toBeNull();
  });

  it('maskable icon is the icon scaled to 80 percent on the theme colour', async () => {
    const id = 'aaaaaaaa-2222-3333-4444-555555555555';
    await icons.set(id, wrap('<rect width="512" height="512" fill="#ff0000"/>'), '#00ff00');
    const { Resvg } = await import('@resvg/resvg-wasm');
    const b64 = fs.readFileSync(icons.png(id, 512, true)!).toString('base64');
    const px = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><image width="512" height="512" href="data:image/png;base64,${b64}"/></svg>`).render().pixels;
    const at = (x: number, y: number): number[] => [...px.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)];
    expect(at(5, 5)).toEqual([0, 255, 0, 255]);
    expect(at(256, 256)).toEqual([255, 0, 0, 255]);
  });

  it('a huge declared size renders at the requested size', async () => {
    const id = 'bbbbbbbb-2222-3333-4444-555555555555';
    const started = Date.now();
    await icons.set(id, `<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000" viewBox="0 0 512 512"><rect width="512" height="512" fill="#123456"/></svg>`, '#123456');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(pngSize(icons.png(id, 512)!)).toEqual({ w: 512, h: 512 });
    expect(pngSize(icons.png(id, 64)!)).toEqual({ w: 64, h: 64 });
  });

  it('setDefault only writes when the app has no icon yet', async () => {
    const id = 'cccccccc-2222-3333-4444-555555555555';
    await icons.setDefault(id, 'todo', '#1f2a5c');
    expect(icons.has(id)).toBe(true);
    const before = fs.readFileSync(icons.png(id, 512)!);
    await icons.set(id, GOOD, '#1f2a5c');
    const custom = fs.readFileSync(icons.png(id, 512)!);
    expect(custom.equals(before)).toBe(false);
    await icons.setDefault(id, 'todo', '#1f2a5c');
    expect(fs.readFileSync(icons.png(id, 512)!).equals(custom)).toBe(true);
  });

  it('a failed set leaves the previous icon untouched', async () => {
    const id = 'dddddddd-2222-3333-4444-555555555555';
    await icons.set(id, GOOD, '#1f2a5c');
    const before = fs.readFileSync(icons.png(id, 512)!);
    await expect(icons.set(id, '<svg><script/></svg>', '#1f2a5c')).rejects.toMatchObject({ reason: 'icon_invalid' });
    expect(fs.readFileSync(icons.png(id, 512)!).equals(before)).toBe(true);
  });

  it('remove deletes the files; has() reflects state', async () => {
    const id = 'eeeeeeee-2222-3333-4444-555555555555';
    expect(icons.has(id)).toBe(false);
    expect(icons.png(id, 512)).toBeNull();
    await icons.set(id, GOOD, '#1f2a5c');
    expect(icons.has(id)).toBe(true);
    const dir = path.dirname(icons.png(id, 512)!);
    icons.remove(id);
    expect(icons.has(id)).toBe(false);
    expect(icons.png(id, 512)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => icons.remove(id)).not.toThrow();
  });

  it('output is written atomically and survives reopen', async () => {
    const dir = tmp();
    const a = new AppIcons(dir);
    await a.ready();
    await a.set(ID, GOOD, '#1f2a5c');
    const folder = path.dirname(a.png(ID, 512)!);
    expect(folder).toBe(path.join(dir, 'apps', ID, 'icon'));
    expect(fs.readdirSync(folder).sort()).toEqual(['icon-180.png', 'icon-192.png', 'icon-512-maskable.png', 'icon-512.png', 'icon-64.png', 'icon.svg']);
    const b = new AppIcons(dir);
    expect(b.has(ID)).toBe(true);
    expect(b.png(ID, 192)).toBe(a.png(ID, 192));
  });

  it('refuses ids that are not plain identifiers', () => {
    expect(icons.png('../../etc', 512)).toBeNull();
    expect(icons.has('../x')).toBe(false);
  });
});

describe('validate', () => {
  it('accepts a plain icon, with comments, a declaration, single quotes and a local gradient', () => {
    expect(() => icons.validate(GOOD)).not.toThrow();
    expect(() => icons.validate(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- hi -->\n<svg\n  xmlns='http://www.w3.org/2000/svg'\n  viewBox = "0 0 512 512" >\n<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>\n<rect width="512" height="512" fill="url(#g)" style="fill:url( '#g' )"/></svg>\n`)).not.toThrow();
    expect(() => icons.validate(wrap('<use href="#a"/><use xlink:href="#a" xmlns:xlink="http://www.w3.org/1999/xlink"/><style>rect{fill:url(#g)}</style>'))).not.toThrow();
  });

  const hostile: Array<[string, string]> = [
    ['script', wrap('<script>alert(1)</script>')],
    ['script, upper case', wrap('<SCRIPT>alert(1)</SCRIPT>')],
    ['script, whitespace before the end of the tag', wrap('<script\n>alert(1)</script >')],
    ['script behind a namespace prefix', wrap('<s:script xmlns:s="http://www.w3.org/2000/svg">1</s:script>')],
    ['onload attribute', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" onload="alert(1)"></svg>'],
    ['ONLOAD, no quotes around the name', wrap('<rect OnClick=\'alert(1)\' width="1"/>')],
    ['foreignObject', wrap('<foreignObject width="10" height="10"><p xmlns="http://www.w3.org/1999/xhtml">x</p></foreignObject>')],
    ['iframe', wrap('<iframe src="http://evil.example"/>')],
    ['image with a remote href', wrap('<image href="http://evil.example/x.png" width="10" height="10"/>')],
    ['image with a data href', wrap('<image href="data:image/png;base64,AAAA" width="10" height="10"/>')],
    ['use with a remote href', wrap('<use href="http://evil.example/x.svg#a"/>')],
    ['use with xlink:href', wrap('<use xlink:href="http://evil.example/x.svg#a" xmlns:xlink="http://www.w3.org/1999/xlink"/>')],
    ['javascript href', wrap('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>')],
    ['javascript href, entity-encoded', wrap('<a href="&#106;avascript:alert(1)"><rect width="1" height="1"/></a>')],
    ['javascript href, hex entity and a tab', wrap('<a href="&#x6A;ava&#9;script:alert(1)"><rect width="1" height="1"/></a>')],
    ['javascript href, leading space', wrap('<a href=" javascript:alert(1)"><rect width="1" height="1"/></a>')],
    ['href that is only a name', wrap('<use href="x.svg#a"/>')],
    ['data href', wrap('<a href="data:text/html,hi"><rect width="1" height="1"/></a>')],
    ['url() in a style attribute', wrap('<rect width="1" height="1" style="fill:url(http://evil.example/x)"/>')],
    ['url() in a presentation attribute', wrap('<rect width="1" height="1" fill="url(http://evil.example/x)"/>')],
    ['URL() in upper case, entity-encoded paren', wrap('<rect width="1" height="1" fill="URL&#40;http://evil.example/x)"/>')],
    ['url() in a style element', wrap('<style>rect{fill:url("http://evil.example/x")}</style>')],
    ['url() in a style element, in CDATA', wrap('<style><![CDATA[rect{fill:url(http://evil.example/x)}]]></style>')],
    ['url() split by a comment inside style', wrap('<style>rect{fill:ur<!-- -->l(http://evil.example/x)}</style>')],
    ['url() written with a css escape', wrap('<style>rect{fill:\\75rl(http://evil.example/x)}</style>')],
    ['@import in a style element', wrap('<style>@import "http://evil.example/x.css";</style>')],
    ['doctype with entities (billion laughs)', '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="&lol2;"/></svg>'],
    ['lower-case doctype', '<!doctype svg><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['entity declaration hidden in a comment', wrap('<!-- <!ENTITY x "y"> --><rect width="1" height="1"/>')],
    ['a stylesheet processing instruction', '<?xml-stylesheet href="http://evil.example/x.css"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['a processing instruction inside the document', wrap('<?php echo 1 ?><rect width="1" height="1"/>')],
    ['text element', wrap('<text x="10" y="10">hi</text>')],
    ['tspan', wrap('<tspan>hi</tspan>')],
    ['unquoted attribute value', wrap('<rect width=10 height="1"/>')],
    ['attribute without a value', wrap('<rect hidden width="1"/>')],
    ['duplicate attribute', wrap('<rect width="1" width="2"/>')],
    ['undefined entity reference', wrap('<rect width="&lol;"/>')],
    ['bare ampersand', wrap('<rect width="a&b"/>')],
    ['"<" in an attribute value', wrap('<rect width="a<b"/>')],
    ['unterminated comment', wrap('<rect width="1"/><!-- never closed')],
    ['unterminated CDATA', wrap('<style><![CDATA[ never closed </style>')],
    ['unterminated tag', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="1"'],
    ['unterminated quote', wrap('<rect width="1/>')],
    ['unclosed element', '<svg xmlns="http://www.w3.org/2000/svg"><g>'],
    ['mismatched closing tag', wrap('<g></rect>')],
    ['space after the opening angle bracket', wrap('< script>1</script>')],
    ['a second root element', wrap('') + '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['text before the root', 'hello' + GOOD],
    ['control character', wrap('<rect width="1"/>\u0000')],
    ['xml:base', wrap('<rect width="1" xml:base="http://evil.example/"/>')],
    ['not svg at all', '<html><body>hi</body></html>'],
    ['an empty string', ''],
    ['plain text', 'just some text'],
    ['svg that is not the root', '<g><svg xmlns="http://www.w3.org/2000/svg"></svg></g>'],
  ];
  for (const [name, svg] of hostile) {
    it(`refuses ${name}`, () => {
      const e = refusal(icons, svg);
      expect(e).toBeInstanceOf(LagerError);
      expect(e.code).toBe('invalid_argument');
      expect(e.reason).toBe('icon_invalid');
      expect(e.message.length).toBeGreaterThan(0);
    });
  }

  it('refuses 70 KiB', () => {
    const e = refusal(icons, wrap(`<!--${'a'.repeat(70 * 1024)}-->`));
    expect(e.reason).toBe('icon_invalid');
    expect(e.message).toMatch(/64 KiB/);
    expect(MAX_ICON_SVG_BYTES).toBe(65536);
  });

  it('counts bytes, not characters', () => {
    expect(() => icons.validate(wrap(`<!--${'ä'.repeat(40000)}-->`))).toThrow(/64 KiB/);
  });

  it('refuses 2001 elements and accepts 2000', () => {
    expect(() => icons.validate(wrap('<rect width="1" height="1"/>'.repeat(1999)))).not.toThrow();
    const e = refusal(icons, wrap('<rect width="1" height="1"/>'.repeat(2000)));
    expect(e.reason).toBe('icon_invalid');
    expect(e.message).toMatch(/2000/);
  });

  it('refuses nesting of 33 levels and accepts 32', () => {
    const nested = (levels: number): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${'<g>'.repeat(levels - 1)}${'</g>'.repeat(levels - 1)}</svg>`;
    expect(() => icons.validate(nested(32))).not.toThrow();
    const e = refusal(icons, nested(33));
    expect(e.message).toMatch(/32/);
  });

  it('a non-square icon is refused when rendered', async () => {
    await expect(icons.set('ffffffff-2222-3333-4444-555555555555', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/></svg>', '#000000'))
      .rejects.toMatchObject({ reason: 'icon_invalid' });
  });

  it('an svg the renderer cannot parse is refused as icon_invalid', async () => {
    await expect(icons.set('ffffffff-2222-3333-4444-555555555556', '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>', '#000000'))
      .rejects.toMatchObject({ code: 'invalid_argument', reason: 'icon_invalid' });
  });
});
