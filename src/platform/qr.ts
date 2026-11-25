/**
 * A QR code encoder for one case: text in byte mode (UTF-8) at error correction level M, any version from 1 to 40, following
 * ISO/IEC 18004. Lager uses it to show the `otpauth://` address of a two-step sign-in setup, so that a phone's authenticator app
 * can read it with the camera; rendering it on the server needs no dependency, no outside service and no script in the page.
 */

/** Error correction codewords per block at level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
/** Error correction blocks at level M, by version (index 0 unused). */
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
/** The two bits that name level M in the format information. */
const LEVEL_M = 0;

export interface QrCode {
  version: number;
  /** Modules per side, without the quiet zone. */
  size: number;
  mask: number;
  /** `modules[y][x]`, true for dark. */
  modules: boolean[][];
}

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

/** Modules available for data and error correction in a symbol of `version`, once the function patterns are drawn. */
function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version: number): number => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The Reed–Solomon generator polynomial of `degree`, highest coefficient (always 1) left out. */
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

/** Positions of the alignment patterns' centres along one axis. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** Data codewords followed by their error correction, split into blocks and interleaved as the symbol stores them. */
function withErrorCorrection(data: number[], version: number): number[] {
  const blocks = BLOCKS[version];
  const eccLen = ECC_PER_BLOCK[version];
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    parts.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < parts[0].length; i++) {
    parts.forEach((block, j) => {
      // The placeholder of the short blocks is not stored.
      if (i !== shortLen - eccLen || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/** The codewords of `bytes` in byte mode, padded to the capacity of `version`. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number): void => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  return out;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Symbol {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private fixed(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }

  private drawFunctionPatterns(): void {
    const last = this.size - 1;
    for (let i = 0; i < this.size; i++) {
      this.fixed(6, i, i % 2 === 0);
      this.fixed(i, 6, i % 2 === 0);
    }
    for (const [x, y] of [[3, 3], [last - 3, 3], [3, last - 3]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const xx = x + dx; const yy = y + dy;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.fixed(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
    const align = alignmentPositions(this.version);
    const n = align.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Not where the finder patterns are.
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.fixed(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = last - 10 + (i % 3); const b = Math.floor(i / 3);
        this.fixed(a, b, bit(bits, i));
        this.fixed(b, a, bit(bits, i));
      }
    }
  }

  drawFormat(mask: number): void {
    const data = (LEVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.fixed(8, i, bit(bits, i));
    this.fixed(8, 7, bit(bits, 6));
    this.fixed(8, 8, bit(bits, 7));
    this.fixed(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.fixed(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.fixed(this.size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.fixed(8, this.size - 15 + i, bit(bits, i));
    this.fixed(8, this.size - 8, true);
  }

  /** Places the codewords in the zigzag order of the standard, two columns at a time from the bottom right. */
  drawCodewords(data: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? this.size - 1 - vert : vert;
          if (!this.reserved[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** Masking twice with the same pattern takes it off again. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) if (!this.reserved[y][x] && MASKS[mask](x, y)) this.modules[y][x] = !this.modules[y][x];
    }
  }

  /** The penalty score of the standard's four rules; the mask with the lowest one is used. */
  penalty(): number {
    const { size, modules: m } = this;
    let score = 0;
    const lines: boolean[][] = [];
    for (let i = 0; i < size; i++) {
      lines.push(m[i]);
      lines.push(m.map((row) => row[i]));
    }
    for (const line of lines) {
      for (let i = 0, run = 1; i < size; i++, run++) {
        if (i === size - 1 || line[i] !== line[i + 1]) {
          if (run >= 5) score += run - 2;
          run = 0;
        }
      }
      score += finderPenalty(line);
    }
    for (let y = 0; y + 1 < size; y++) {
      for (let x = 0; x + 1 < size; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/**
 * Rule 3 of the mask penalty for one row or column: 40 for each dark-light-dark-dark-dark-light-dark run with four light modules
 * before it, and 40 more with four after it (each side on its own, as in Nayuki's encoder; ZXing scores one penalty per run).
 * Outside the symbol is the quiet zone, which is light, as the standard has it.
 */
export function finderPenalty(line: boolean[]): number {
  const finderLike = [true, false, true, true, true, false, true];
  const light = (k: number): boolean => k < 0 || k >= line.length || !line[k];
  let score = 0;
  for (let i = 0; i + 7 <= line.length; i++) {
    if (!finderLike.every((d, k) => line[i + k] === d)) continue;
    if ([1, 2, 3, 4].every((k) => light(i - k))) score += 40;
    if ([7, 8, 9, 10].every((k) => light(i + k))) score += 40;
  }
  return score;
}

/** Whether `version` holds `bytes` bytes in byte mode at level M: mode, length and data bits against its data codewords. */
const holds = (version: number, bytes: number): boolean => 4 + (version <= 9 ? 8 : 16) + bytes * 8 <= dataCodewords(version) * 8;

/** Whether `text` fits in a QR code at all (version 40 at level M); encodeQr refuses anything longer. */
export const fitsQr = (text: string): boolean => holds(40, new TextEncoder().encode(text).length);

/** Encodes `text` at level M in the smallest version it fits; `mask` forces a mask pattern (0 to 7) instead of the best one. */
export function encodeQr(text: string, mask?: number): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (!holds(version, bytes.length)) {
    if (++version > 40) throw new RangeError('Too long for a QR code.');
  }
  const data = withErrorCorrection(codewords(bytes, version), version);
  const symbol = new Symbol(version);
  symbol.drawCodewords(data);
  let chosen = mask ?? -1;
  if (chosen < 0) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      symbol.applyMask(k);
      symbol.drawFormat(k);
      const score = symbol.penalty();
      if (score < best) { best = score; chosen = k; }
      symbol.applyMask(k);
    }
  }
  symbol.applyMask(chosen);
  symbol.drawFormat(chosen);
  return { version, size: symbol.size, mask: chosen, modules: symbol.modules };
}

/**
 * The code as an SVG image: dark modules on white with the quiet zone of four modules the standard asks for, in both colour
 * schemes, so cameras read it in dark mode too. `label` is its accessible name (plain text, escaped here).
 */
export function qrSvg(text: string, label: string): string {
  const qr = encodeQr(text);
  const quiet = 4;
  const side = qr.size + quiet * 2;
  let path = '';
  qr.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
  const name = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Four screen pixels per module: every module the same size at 1x, where a phone reads it off a monitor (a 61-module code: 244px).
  const px = side * 4;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${px}" height="${px}" role="img" aria-label="${name}" shape-rendering="crispEdges">`
    + `<rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
