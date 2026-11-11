import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { LagerError } from '../errors.js';
import { defaultIconSvg } from './default-icon.js';

export const ICON_SIZES = [512, 192, 180, 64] as const;
export const MAX_ICON_SVG_BYTES = 65536;
export const DEFAULT_THEME_COLOR = '#1f2a5c';
const MAX_ELEMENTS = 2000;
const MAX_DEPTH = 32;
const RENDER_BUDGET_MS = 2000;
/** The maskable variant shows the icon at this share of the canvas, inside the platform-safe zone. */
const MASKABLE_SCALE = 0.8;
const MAX_ID_LENGTH = 64;

/** Elements that are never needed to draw an icon from shapes: code, embedding, external content and text (the renderer has no fonts). */
const FORBIDDEN_ELEMENTS = new Set([
  'script', 'foreignobject', 'iframe', 'image', 'text', 'tspan', 'textpath', 'tref', 'embed', 'object', 'link', 'meta', 'base',
  'audio', 'video', 'canvas', 'frame', 'frameset', 'handler', 'listener', 'html', 'body',
]);

const iconInvalid = (message: string): never => {
  throw new LagerError('invalid_argument', `The icon cannot be used: ${message}`, 'icon_invalid');
};

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const WS = /[ \t\r\n]/;
const BAD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const ENTITY = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1).toLowerCase();

/** Decodes the five predefined entities and numeric references once; any other `&` makes the document unparseable. */
function decode(text: string): string {
  if (!text.includes('&')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '&') { out += text[i]; continue; }
    const m = ENTITY.exec(text.slice(i, i + 12));
    if (!m) return iconInvalid('it uses an entity reference that is not defined (only &amp; &lt; &gt; &quot; &apos; and numeric references are allowed).');
    const body = m[0].slice(1, -1);
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) {
        return iconInvalid('it contains an invalid character reference.');
      }
      out += String.fromCodePoint(code);
    } else {
      out += NAMED[body];
    }
    i += m[0].length - 1;
  }
  return out;
}

/** CSS (a style element or any attribute value): references may only point to a fragment of the same document. */
function scanCss(text: string, strict: boolean): void {
  if (strict && text.includes('\\')) iconInvalid('CSS escapes are not allowed.');
  const lower = text.toLowerCase();
  if (strict) for (const word of ['@import', '@font-face', 'image-set(', 'expression(', 'src(']) {
    if (lower.includes(word)) iconInvalid(`"${word}" is not allowed in CSS.`);
  }
  for (const m of lower.matchAll(/url\s*\(/g)) {
    const rest = lower.slice(m.index + m[0].length).replace(/^\s+/, '').replace(/^["']\s*/, '');
    if (!rest.startsWith('#')) iconInvalid('url() may only point to an element of the icon itself (#id).');
  }
}

function checkAttribute(name: string, raw: string): void {
  const value = decode(raw);
  const local = localName(name);
  if (local.startsWith('on')) iconInvalid(`the event handler attribute "${name}" is not allowed.`);
  if (name.toLowerCase() === 'xml:base') iconInvalid('xml:base is not allowed.');
  if (local === 'href' && !value.replace(/^[\u0000- ]+/, '').startsWith('#')) {
    iconInvalid('href may only point to an element of the icon itself (#id).');
  }
  scanCss(value, local === 'style');
}

/**
 * Walks the SVG text tag by tag. It accepts only what a strict XML parser would and refuses everything it cannot parse cleanly,
 * so no spelling (case, whitespace, quoting, entities, CDATA, comments, processing instructions) can hide a forbidden construct.
 */
function tokenize(svg: string): void {
  const n = svg.length;
  const start = svg.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: Array<{ name: string; local: string }> = [];
  let elements = 0;
  let rootSeen = false;
  let styleText = '';
  let i = start;

  const text = (chunk: string, raw: boolean): void => {
    if (stack.length === 0) {
      if (chunk.trim() !== '') iconInvalid('there is content outside the <svg> element.');
      return;
    }
    const decoded = raw ? chunk : decode(chunk);
    if (stack[stack.length - 1].local === 'style') styleText += decoded;
  };

  while (i < n) {
    const lt = svg.indexOf('<', i);
    text(svg.slice(i, lt < 0 ? n : lt), false);
    if (lt < 0) { i = n; break; }
    i = lt;
    if (svg.startsWith('<!--', i)) {
      const end = svg.indexOf('-->', i + 4);
      if (end < 0) iconInvalid('a comment is not closed.');
      if (svg.slice(i + 4, end).includes('--')) iconInvalid('a comment contains "--".');
      i = end + 3;
      continue;
    }
    if (svg.startsWith('<![CDATA[', i)) {
      const end = svg.indexOf(']]>', i + 9);
      if (end < 0) iconInvalid('a CDATA section is not closed.');
      if (stack.length === 0) iconInvalid('there is content outside the <svg> element.');
      text(svg.slice(i + 9, end), true);
      i = end + 3;
      continue;
    }
    if (svg.startsWith('<?', i)) {
      // Only the XML declaration at the very start; anything else (xml-stylesheet, …) can pull in external resources.
      if (i !== start || !/^<\?xml[ \t\r\n]/.test(svg.slice(i, i + 7))) iconInvalid('processing instructions are not allowed.');
      const end = svg.indexOf('?>', i + 2);
      if (end < 0) iconInvalid('the XML declaration is not closed.');
      i = end + 2;
      continue;
    }
    if (svg.startsWith('<!', i)) iconInvalid('DOCTYPE and ENTITY declarations are not allowed.');

    if (svg[i + 1] === '/') {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(svg);
      if (!m) { iconInvalid('a closing tag is malformed.'); return; }
      let j = i + 2 + m[0].length;
      while (j < n && WS.test(svg[j])) j++;
      if (svg[j] !== '>') iconInvalid('a closing tag is malformed.');
      const open = stack.pop();
      if (!open || open.name !== m[0]) iconInvalid('the tags are not properly nested.');
      if (open!.local === 'style') { scanCss(styleText, true); styleText = ''; }
      i = j + 1;
      continue;
    }

    NAME.lastIndex = i + 1;
    const m = NAME.exec(svg);
    if (!m) { iconInvalid('a tag is malformed.'); return; }
    const name = m[0];
    const local = localName(name);
    let j = i + 1 + name.length;
    const seen = new Set<string>();
    const attributes: Array<[string, string]> = [];
    let selfClosing = false;
    for (;;) {
      const before = j;
      while (j < n && WS.test(svg[j])) j++;
      if (j >= n) iconInvalid('a tag is not closed.');
      if (svg[j] === '>') { j++; break; }
      if (svg.startsWith('/>', j)) { selfClosing = true; j += 2; break; }
      if (j === before) iconInvalid('attributes must be separated by whitespace.');
      NAME.lastIndex = j;
      const a = NAME.exec(svg);
      if (!a) { iconInvalid('an attribute is malformed.'); return; }
      j += a[0].length;
      while (j < n && WS.test(svg[j])) j++;
      if (svg[j] !== '=') iconInvalid(`the attribute "${a[0]}" has no value.`);
      j++;
      while (j < n && WS.test(svg[j])) j++;
      const quote = svg[j];
      if (quote !== '"' && quote !== "'") iconInvalid(`the value of "${a[0]}" is not quoted.`);
      const close = svg.indexOf(quote, j + 1);
      if (close < 0) iconInvalid(`the value of "${a[0]}" is not closed.`);
      const value = svg.slice(j + 1, close);
      if (value.includes('<')) iconInvalid(`the value of "${a[0]}" contains "<".`);
      if (seen.has(a[0])) iconInvalid(`the attribute "${a[0]}" appears twice.`);
      seen.add(a[0]);
      attributes.push([a[0], value]);
      j = close + 1;
    }

    if (FORBIDDEN_ELEMENTS.has(local)) iconInvalid(`<${local}> is not allowed (draw shapes and paths only, no text, images or scripts).`);
    if (stack.length === 0) {
      if (rootSeen) iconInvalid('there is more than one root element.');
      if (local !== 'svg') iconInvalid('the root element must be <svg>.');
      rootSeen = true;
    } else if (stack[stack.length - 1].local === 'style') {
      iconInvalid('<style> may only contain text.');
    }
    if (++elements > MAX_ELEMENTS) iconInvalid(`it has more than ${MAX_ELEMENTS} elements.`);
    if (stack.length + 1 > MAX_DEPTH) iconInvalid(`it is nested deeper than ${MAX_DEPTH} levels.`);
    for (const [k, v] of attributes) checkAttribute(k, v);
    if (!selfClosing) stack.push({ name, local });
    i = j;
  }
  if (stack.length > 0) iconInvalid('an element is not closed.');
  if (!rootSeen) iconInvalid('the root element must be <svg>.');
}

let wasm: Promise<void> | undefined;
/** The wasm is initialised once per process; a second module instance in the same process finds it already initialised. */
function loadWasm(): Promise<void> {
  wasm ??= (async () => {
    const file = createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
    try {
      await initWasm(fs.promises.readFile(file));
    } catch (e) {
      if (!/already initialized/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  })();
  return wasm;
}

function render(svg: string, size: number): { png: Uint8Array } {
  const started = Date.now();
  let png: Uint8Array;
  try {
    const image = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render();
    if (image.width !== size || image.height !== size) iconInvalid('the icon must be square (use viewBox="0 0 512 512").');
    png = image.asPng();
  } catch (e) {
    if (e instanceof LagerError) throw e;
    return iconInvalid(`it could not be drawn (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (Date.now() - started > RENDER_BUDGET_MS) iconInvalid('it takes too long to draw.');
  return { png };
}

const validId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) && id.length <= MAX_ID_LENGTH;

export class AppIcons {
  constructor(private dataDir: string) {}

  /** Loads the renderer; call and await it once before `set` or `setDefault`. Safe to call repeatedly. */
  ready(): Promise<void> {
    return loadWasm();
  }

  validate(svg: string): void {
    if (typeof svg !== 'string') iconInvalid('icon_svg must be a string.');
    if (Buffer.byteLength(svg) > MAX_ICON_SVG_BYTES) iconInvalid('it is larger than 64 KiB.');
    if (BAD_CONTROL.test(svg)) iconInvalid('it contains control characters.');
    if (/<!(?:doctype|entity)/i.test(svg)) iconInvalid('DOCTYPE and ENTITY declarations are not allowed.');
    tokenize(svg);
  }

  private folder(appId: string): string {
    return path.join(this.dataDir, 'apps', appId, 'icon');
  }

  /** Validates, renders every size plus the maskable 512, and swaps the files in; on any failure the previous icon stays. */
  async set(appId: string, svg: string, themeColor: string): Promise<void> {
    if (!validId(appId)) throw new LagerError('invalid_argument', 'Invalid app id.');
    this.validate(svg);
    await this.ready();
    const files = new Map<string, Uint8Array | string>();
    for (const size of ICON_SIZES) files.set(`icon-${size}.png`, render(svg, size).png);
    const inner = Math.round(512 * MASKABLE_SCALE);
    const offset = (512 - inner) / 2;
    const color = /^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor : DEFAULT_THEME_COLOR;
    const embedded = Buffer.from(render(svg, inner).png).toString('base64');
    files.set('icon-512-maskable.png', render(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="${color}"/>`
      + `<image x="${offset}" y="${offset}" width="${inner}" height="${inner}" href="data:image/png;base64,${embedded}"/></svg>`, 512).png);
    files.set('icon.svg', svg);

    const dir = this.folder(appId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = crypto.randomUUID();
    const temps: Array<[string, string]> = [];
    try {
      // icon-512.png goes last: `has` looks at it, so a half-written set is never reported as present.
      const order = [...files.keys()].filter((k) => k !== 'icon-512.png').concat('icon-512.png');
      for (const name of order) {
        const tmp = path.join(dir, `${name}.${stamp}.tmp`);
        fs.writeFileSync(tmp, files.get(name)!);
        temps.push([tmp, path.join(dir, name)]);
      }
      for (const [tmp, target] of temps) fs.renameSync(tmp, target);
    } catch (e) {
      for (const [tmp] of temps) fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Writes the generated icon for `slug`, only when the app has none yet. */
  async setDefault(appId: string, slug: string, themeColor: string): Promise<void> {
    if (this.has(appId)) return;
    await this.set(appId, defaultIconSvg(slug), themeColor);
  }

  has(appId: string): boolean {
    return validId(appId) && fs.existsSync(path.join(this.folder(appId), 'icon-512.png'));
  }

  /** The stored source of the icon (server-side only; an SVG is never sent to a browser), or null. */
  source(appId: string): string | null {
    if (!this.has(appId)) return null;
    try { return fs.readFileSync(path.join(this.folder(appId), 'icon.svg'), 'utf8'); } catch { return null; }
  }

  png(appId: string, size: (typeof ICON_SIZES)[number], maskable = false): string | null {
    if (!validId(appId) || !(ICON_SIZES as readonly number[]).includes(size)) return null;
    if (maskable && size !== 512) return null;
    const file = path.join(this.folder(appId), maskable ? 'icon-512-maskable.png' : `icon-${size}.png`);
    return fs.existsSync(file) ? file : null;
  }

  remove(appId: string): void {
    if (!validId(appId)) return;
    fs.rmSync(this.folder(appId), { recursive: true, force: true });
  }
}
