import crypto from 'node:crypto';

/** Simple white shapes on a 512 x 512 canvas; each stays legible at 48 px. */
const GLYPHS: Array<{ name: string; svg: string }> = [
  { name: 'disc', svg: '<circle cx="256" cy="256" r="120"/>' },
  { name: 'ring', svg: '<circle cx="256" cy="256" r="110" fill="none" stroke="#fff" stroke-width="44"/>' },
  { name: 'diamond', svg: '<path d="M256 120 392 256 256 392 120 256Z"/>' },
  { name: 'triangle', svg: '<path d="M256 118 396 372H116Z"/>' },
  { name: 'plus', svg: '<path d="M224 120h64v104h104v64H288v104h-64V288H120v-64h104Z"/>' },
  { name: 'bars', svg: '<rect x="118" y="256" width="68" height="136" rx="10"/><rect x="222" y="170" width="68" height="222" rx="10"/><rect x="326" y="120" width="68" height="272" rx="10"/>' },
  { name: 'star', svg: '<path d="M256 112 292 214 400 218 314 284 344 388 256 328 168 388 198 284 112 218 220 214Z"/>' },
  { name: 'hexagon', svg: '<path d="M256 112 381 184V328L256 400 131 328V184Z"/>' },
  { name: 'wave', svg: '<path d="M104 300C150 200 200 200 256 256S362 312 408 212" fill="none" stroke="#fff" stroke-width="48" stroke-linecap="round"/>' },
  { name: 'half', svg: '<path d="M136 330a120 120 0 0 1 240 0Z"/><rect x="136" y="354" width="240" height="40" rx="10"/>' },
  { name: 'squares', svg: '<rect x="120" y="120" width="124" height="124" rx="16"/><rect x="268" y="120" width="124" height="124" rx="16"/><rect x="120" y="268" width="124" height="124" rx="16"/><rect x="268" y="268" width="124" height="124" rx="16"/>' },
];

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** A deterministic 512 x 512 icon for `seed` (the slug): a two-colour gradient with one white geometric glyph, no text. */
export function defaultIconSvg(seed: string): string {
  const bytes = crypto.createHash('sha256').update(`lager-icon:${seed}`).digest();
  const hue = (bytes[0] * 256 + bytes[1]) % 360;
  const shift = 40 + (bytes[2] % 80);
  const glyph = GLYPHS[bytes[3] % GLYPHS.length];
  const from = hsl(hue, 0.62, 0.34);
  const to = hsl((hue + shift) % 360, 0.68, 0.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">`
    + `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`
    + `<!--glyph:${glyph.name}--><rect width="512" height="512" fill="url(#bg)"/><g fill="#fff">${glyph.svg}</g></svg>`;
}
