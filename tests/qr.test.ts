import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { encodeQr, qrSvg } from '../src/platform/qr.js';

/**
 * Reference symbols made with the Python `qrcode` package (8.2) at level M in byte mode, with the mask given: versions 1 to 26,
 * so they cover the version information (7 and up), the 16-bit length (10 and up) and blocks of two lengths.
 */
const VECTORS = JSON.parse(fs.readFileSync(new URL('./fixtures/qr-vectors.json', import.meta.url), 'utf8')) as Array<{ text: string; mask: number; version: number; rows: string[] }>;

const rows = (modules: boolean[][]): string[] => modules.map((r) => r.map((d) => (d ? '1' : '0')).join(''));

/** The 15 format bits as stored around the top-left finder, read back. */
function formatOf(modules: boolean[][]): number {
  const at = (x: number, y: number): number => (modules[y][x] ? 1 : 0);
  const coords: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  return coords.reduce((acc, [x, y], i) => acc | (at(x, y) << i), 0);
}

describe('QR encoder', () => {
  it('matches the reference symbols module for module', () => {
    for (const v of VECTORS) {
      const qr = encodeQr(v.text, v.mask);
      expect(qr.version, v.text.slice(0, 30)).toBe(v.version);
      expect(rows(qr.modules), v.text.slice(0, 30)).toEqual(v.rows);
    }
  });

  it('picks one mask by the penalty rules and writes it, with level M, into valid format information', () => {
    for (const v of VECTORS) {
      const qr = encodeQr(v.text);
      expect(rows(qr.modules)).toEqual(rows(encodeQr(v.text, qr.mask).modules));
      const raw = formatOf(qr.modules) ^ 0x5412;
      // Level M is 00; the mask follows; the remaining ten bits are the BCH code of those five.
      expect(raw >>> 13).toBe(0);
      expect((raw >>> 10) & 7).toBe(qr.mask);
      let rem = raw >>> 10;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      expect(raw & 0x3ff).toBe(rem & 0x3ff);
    }
  });

  it('refuses text longer than version 40 holds', () => {
    expect(encodeQr('a'.repeat(2331)).version).toBe(40);
    expect(() => encodeQr('a'.repeat(2332))).toThrow(RangeError);
  });

  it('draws black on white with a quiet zone, as an image with a name', () => {
    const svg = qrSvg('otpauth://x', 'Code "for" <you>');
    const el = new JSDOM(svg).window.document.querySelector('svg')!;
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Code "for" <you>');
    // Version 1: 21 modules and four on each side.
    expect(el.getAttribute('viewBox')).toBe('0 0 29 29');
    // Drawn at four pixels per module, so every module is the same size on a 1x screen.
    expect([el.getAttribute('width'), el.getAttribute('height')]).toEqual(['116', '116']);
    expect(el.querySelector('rect')!.getAttribute('fill')).toBe('#fff');
    expect(el.querySelector('path')!.getAttribute('fill')).toBe('#000');
    expect(el.querySelector('path')!.getAttribute('d')!.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
